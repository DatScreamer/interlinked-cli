// ===========================================
// interlinked compact — lossless gzip + rotation of activity.jsonl
// ===========================================
// The activity log is an append-only, full-fidelity capture (raw — redaction
// is egress-only). It grows without bound. `compact` reclaims disk losslessly:
// it gzips a SAFE PREFIX of activity.jsonl into a numbered archive segment,
// truncates the live file to the remainder, and adjusts the sync cursor. Every
// byte is preserved (recoverable by gunzipping the segments in manifest order).
//
// "Safe prefix" satisfies three invariants so nothing downstream breaks:
//   1. Cursor-safe — never archive past `synced_through_bytes`; the unsynced
//      tail stays live and the cursor is decremented by the archived bytes, so
//      batchSync keeps sending exactly the un-sent events.
//   2. Audit-safe — never archive past the START of the last hash-chained
//      record (guard_*/session_end). That record stays live, so the hook's
//      write-time `readPreviousGuardHash` (tail read) still finds the latest
//      hash and the chain continues unbroken across the boundary.
//   3. Line-aligned — the cut is always on a record boundary.
//
// `interlinked audit verify` reads archive segments (manifest order) before the
// live file, so the hash chain verifies end-to-end across compaction.
//
// NOTE: not crash-atomic. The window between truncating the live file and
// writing the manifest is two small writes; if interrupted there, re-run
// `interlinked compact` — it is idempotent on an already-compacted state.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Command, OptionValues } from "commander";
import { getDataDir } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

/** Record types that participate in the audit hash chain (mirror audit-chain.ts). */
const CHAINED_TYPES = new Set(["guard_block", "guard_warn", "guard_allow", "session_end"]);

/** Default: keep at least this many recent bytes live (recent reads + audit headroom). */
const DEFAULT_KEEP_RECENT_BYTES = 2 * 1024 * 1024;

const NEWLINE = 0x0a;

export interface ArchiveSegment {
	seq: number;
	file: string;
	bytes: number;
	gz_bytes: number;
	records: number;
	created_at: string;
}

export interface ArchiveManifest {
	version: 1;
	segments: ArchiveSegment[];
}

function archiveDirPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "archive");
}

function archiveManifestPath(cwd: string = process.cwd()): string {
	return join(archiveDirPath(cwd), "manifest.json");
}

/** One manifest segment. Written exclusively by `compactCommand` below (a
 *  single in-repo writer, unlike the multi-writer activity/collection logs),
 *  so an entry that doesn't match this shape is corruption rather than a
 *  legitimately-optional legacy field — the whole manifest falls back to
 *  empty rather than silently serving a partial segment list to `audit
 *  verify`, which reads segments in manifest order to walk the hash chain. */
function parseArchiveSegment(value: unknown): ArchiveSegment | null {
	if (!isJsonObject(value)) return null;
	const { seq, file, bytes, gz_bytes, records, created_at } = value;
	if (typeof seq !== "number" || typeof file !== "string") return null;
	if (typeof bytes !== "number" || typeof gz_bytes !== "number") return null;
	if (typeof records !== "number" || typeof created_at !== "string") return null;
	return { seq, file, bytes, gz_bytes, records, created_at };
}

function parseArchiveManifest(value: unknown): ArchiveManifest | null {
	if (!isJsonObject(value) || !Array.isArray(value.segments)) return null;
	const segments: ArchiveSegment[] = [];
	for (const entry of value.segments) {
		const seg = parseArchiveSegment(entry);
		if (!seg) return null;
		segments.push(seg);
	}
	return { version: 1, segments };
}

export function loadArchiveManifest(cwd: string = process.cwd()): ArchiveManifest {
	const path = archiveManifestPath(cwd);
	if (!existsSync(path)) return { version: 1, segments: [] };
	try {
		return parseArchiveManifest(JSON.parse(readFileSync(path, "utf-8"))) ?? { version: 1, segments: [] };
	} catch {
		return { version: 1, segments: [] };
	}
}

interface PlanResult {
	cutByte: number; // bytes archived (prefix length)
	records: number; // records in the prefix
	liveAfter: number; // live file size after compaction
	reason?: string; // why nothing is archivable (when cutByte === 0)
}

/**
 * Find the safe cut point: the largest record-boundary offset that is
 * <= min(syncedBytes, fileSize - keepRecentBytes) AND <= the start of the last
 * hash-chained record.
 */
function planCut(
	buf: Buffer,
	syncedBytes: number,
	keepRecentBytes: number,
	ignoreSync = false,
): PlanResult {
	const fileSize = buf.length;
	const lineStarts: number[] = [0];
	let lastChainedStart = -1;
	let lineStart = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] !== NEWLINE) continue;
		const line = buf.toString("utf-8", lineStart, i).trim();
		if (line) {
			try {
				const rec = JSON.parse(line);
				if (
					isJsonObject(rec) &&
					typeof rec.type === "string" &&
					CHAINED_TYPES.has(rec.type) &&
					typeof rec.hash === "string"
				) {
					lastChainedStart = lineStart;
				}
			} catch {
				/* intentional: skip malformed line, keep scanning offsets */
			}
		}
		lineStart = i + 1;
		if (lineStart < fileSize) lineStarts.push(lineStart);
	}

	const syncBound = ignoreSync ? fileSize : syncedBytes;
	let limit = Math.min(syncBound, fileSize - keepRecentBytes);
	if (lastChainedStart >= 0) limit = Math.min(limit, lastChainedStart);
	if (limit <= 0) {
		const reason =
			!ignoreSync && syncedBytes <= 0
				? "no synced data yet — pass --all to compact a local-only log"
				: fileSize - keepRecentBytes <= 0
					? `log is within the ${(keepRecentBytes / 1024 / 1024).toFixed(1)}MB recent-tail kept live`
					: "the pre-audit-tail region is empty";
		return { cutByte: 0, records: 0, liveAfter: fileSize, reason };
	}

	let cutByte = 0;
	for (const start of lineStarts) {
		if (start <= limit) cutByte = start;
		else break;
	}
	if (cutByte <= 0) {
		return { cutByte: 0, records: 0, liveAfter: fileSize, reason: "first record exceeds the archivable region" };
	}
	const records = lineStarts.filter((s) => s < cutByte).length;
	return { cutByte, records, liveAfter: fileSize - cutByte };
}

export async function compactCommand(opts: OptionValues): Promise<void> {
	const cwd = typeof opts.cwd === "string" ? opts.cwd : process.cwd();
	const isJson = Boolean(opts.json);
	const dryRun = Boolean(opts.dryRun);
	const keepRecentBytes =
		typeof opts.keepRecentBytes === "number" ? opts.keepRecentBytes : DEFAULT_KEEP_RECENT_BYTES;

	const dataDir = getDataDir(cwd);
	const activityPath = join(dataDir, "activity.jsonl");
	const syncStatePath = join(dataDir, "sync-state.json");
	const archiveDir = archiveDirPath(cwd);
	const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

	const emit = (data: JsonObject, human: string) => {
		if (isJson) console.log(JSON.stringify(data, null, 2));
		else console.log(human);
	};

	if (!existsSync(activityPath)) {
		emit({ compacted: false, reason: "no activity.jsonl" }, c.dim("Nothing to compact — no activity.jsonl."));
		return;
	}

	const fileSize = statSync(activityPath).size;

	let syncedBytes = 0;
	let syncState: JsonObject = {};
	if (existsSync(syncStatePath)) {
		try {
			syncState = JSON.parse(readFileSync(syncStatePath, "utf-8")) as JsonObject;
			if (typeof syncState.synced_through_bytes === "number") {
				syncedBytes = syncState.synced_through_bytes;
			}
		} catch {
			/* intentional: malformed sync-state — treat as nothing synced (safe) */
		}
	}

	const ignoreSync = Boolean(opts.all);
	const buf = readFileSync(activityPath);
	const plan = planCut(buf, syncedBytes, keepRecentBytes, ignoreSync);

	if (plan.cutByte <= 0) {
		emit(
			{ compacted: false, file_bytes: fileSize, synced_bytes: syncedBytes, reason: plan.reason },
			`${c.dim("Nothing safely compactable")} — ${plan.reason}.\n  ${c.dim(`log ${mb(fileSize)}MB, synced ${mb(syncedBytes)}MB`)}`,
		);
		return;
	}

	const manifest = loadArchiveManifest(cwd);
	const seq = (manifest.segments.at(-1)?.seq ?? 0) + 1;
	const segmentFile = `activity-${String(seq).padStart(4, "0")}.jsonl.gz`;
	const gz = gzipSync(buf.subarray(0, plan.cutByte));

	if (dryRun) {
		emit(
			{
				compacted: false,
				dry_run: true,
				would_archive_bytes: plan.cutByte,
				would_archive_records: plan.records,
				gz_bytes: gz.length,
				live_after_bytes: plan.liveAfter,
				segment: segmentFile,
			},
			`${c.bold("Dry run")} — would archive ${mb(plan.cutByte)}MB (${plan.records} records) → ${segmentFile}\n` +
				`  gzipped: ${mb(gz.length)}MB (${Math.round((1 - gz.length / plan.cutByte) * 100)}% smaller)\n` +
				`  live activity.jsonl after: ${mb(plan.liveAfter)}MB`,
		);
		return;
	}

	// 1) Write the gzipped segment (temp → rename so a reader never sees a partial .gz).
	mkdirSync(archiveDir, { recursive: true });
	const segPath = join(archiveDir, segmentFile);
	const segTmp = `${segPath}.tmp`;
	writeFileSync(segTmp, gz);
	renameSync(segTmp, segPath);

	// 2) Truncate the live file to the remainder (temp → atomic rename).
	const liveTmp = `${activityPath}.compact.tmp`;
	writeFileSync(liveTmp, buf.subarray(plan.cutByte));
	renameSync(liveTmp, activityPath);

	// 3) Adjust the sync cursor: archived bytes were already synced, so the
	//    cursor (offset into the now-shorter live file) drops by the same amount.
	syncState.synced_through_bytes = Math.max(0, syncedBytes - plan.cutByte);
	writeFileSync(syncStatePath, JSON.stringify(syncState));

	// 4) Record the segment in the manifest (read order for audit verify).
	manifest.segments.push({
		seq,
		file: segmentFile,
		bytes: plan.cutByte,
		gz_bytes: gz.length,
		records: plan.records,
		created_at: new Date().toISOString(),
	});
	writeFileSync(archiveManifestPath(cwd), JSON.stringify(manifest, null, 2));

	emit(
		{
			compacted: true,
			segment: segmentFile,
			archived_bytes: plan.cutByte,
			archived_records: plan.records,
			gz_bytes: gz.length,
			live_after_bytes: plan.liveAfter,
			synced_through_bytes: syncState.synced_through_bytes,
		},
		`${c.green("✓ Compacted")} ${mb(plan.cutByte)}MB (${plan.records} records) → archive/${segmentFile}\n` +
			`  gzipped to ${mb(gz.length)}MB (${Math.round((1 - gz.length / plan.cutByte) * 100)}% smaller, lossless)\n` +
			`  live activity.jsonl: ${mb(fileSize)}MB → ${mb(plan.liveAfter)}MB\n` +
			`  ${c.dim(`recover: gunzip -c .interlinked/archive/${segmentFile}  ·  audit verify reads archives automatically`)}`,
	);
}

/** Register the `compact` subcommand on the root program (keeps index.ts under its line cap). */
export function registerCompactCommand(program: Command): void {
	program
		.command("compact")
		.description("Gzip + archive the synced prefix of activity.jsonl (lossless), reclaiming disk")
		.option("--dry-run", "Show what would be archived without changing anything")
		.option("--keep-recent-mb <mb>", "Keep at least this many MB of recent log live", "2")
		.option("--all", "Archive past the recent tail even when un-synced (local-only / disk recovery; archived events won't be sent to the server)")
		.option("--json", "Machine-readable output")
		.action((opts: OptionValues) =>
			compactCommand({
				...opts,
				keepRecentBytes: Math.round(
					Number.parseFloat(String(opts.keepRecentMb ?? "2")) * 1024 * 1024,
				),
			}),
		);
}
