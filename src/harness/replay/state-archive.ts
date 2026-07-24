// ===========================================
// G2 per-step harness-state archive
// ===========================================
// The tree snapshot deliberately excludes `.interlinked/`, and nothing else
// retains harness state historically: `<id>.live.json` is overwritten every
// event and DELETED at SessionEnd (server/lifecycle-persist.ts), and the
// ratchet water-line files are mostly gitignored, so neither is recoverable
// from tree snapshots. This module archives, per step: the serialized live
// snapshot + the six baseline files — content-addressed so unchanged-state
// steps dedup to a single blob (the common case). Tier 2's restore reads
// THIS, never `live.json` (docs/design/reproducibility/g2-tree-snapshots.md).
//
// Contract: recordStateSnapshot never throws (fail-open, logs); the loader
// is for explicit restore/test paths.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { JsonObject } from "../../lib/json-types.js";
import { sanitizeSessionId } from "../session-paths.js";

/** The six ratchet water-line files (audited 2026-07-24: only large-files +
 *  untested-files are git-tracked; the rest are gitignored or absent — which
 *  is exactly why they must ride the state archive, not the tree). */
export const BASELINE_FILES: readonly string[] = [
	"coverage-baseline.json",
	"coverage-edit-baseline.json",
	"mutation-baseline.json",
	"large-files-baseline.json",
	"untested-files-baseline.json",
	"metric-caps.json",
];

export interface HarnessStateSnapshot {
	schema: "state-snapshot.v1";
	live_snapshot: JsonObject | null;
	/** File content, or null when the file did not exist at capture time
	 *  (recorded explicitly — never silently missing). */
	baselines: Record<string, string | null>;
}

interface PointerRow {
	seq: number | null;
	sha: string;
	ts: string;
}

function stateDir(cwd: string): string {
	return join(cwd, ".interlinked", "replay", "state");
}

function pointerPath(cwd: string, sessionId: string): string {
	const safe = sanitizeSessionId(sessionId) || "unknown-session";
	return join(stateDir(cwd), `${safe}.jsonl`);
}

/** Archive the harness state for one step. Fail-open: logs and returns on
 *  any error — this sits on the daemon's per-event path. */
export function recordStateSnapshot(opts: {
	cwd: string;
	sessionId: string;
	seq: number | null | undefined;
	liveSnapshot: JsonObject | null;
	log: (msg: string) => void;
}): void {
	try {
		const baselines: Record<string, string | null> = {};
		for (const name of BASELINE_FILES) {
			const path = join(opts.cwd, ".interlinked", name);
			baselines[name] = existsSync(path) ? readFileSync(path, "utf-8") : null;
		}
		const state: HarnessStateSnapshot = {
			schema: "state-snapshot.v1",
			live_snapshot: opts.liveSnapshot,
			baselines,
		};
		const canonical = JSON.stringify(state);
		const sha = createHash("sha256").update(canonical).digest("hex");

		const blobsDir = join(stateDir(opts.cwd), "blobs");
		mkdirSync(blobsDir, { recursive: true });
		const blobPath = join(blobsDir, `${sha}.json.gz`);
		if (!existsSync(blobPath)) writeFileSync(blobPath, gzipSync(canonical));

		const row: PointerRow = {
			seq: opts.seq ?? null,
			sha,
			ts: new Date().toISOString(),
		};
		appendFileSync(pointerPath(opts.cwd, opts.sessionId), `${JSON.stringify(row)}\n`);
	} catch (err) {
		opts.log(
			`state snapshot failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Load the archived state for an exact (session, seq). Returns the LAST
 *  matching row's blob (later rows win when a seq repeats), or null. */
export function loadStateSnapshot(
	cwd: string,
	sessionId: string,
	seq: number,
): HarnessStateSnapshot | null {
	const path = pointerPath(cwd, sessionId);
	if (!existsSync(path)) return null;
	let sha: string | null = null;
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as PointerRow;
			if (row && row.seq === seq && typeof row.sha === "string") sha = row.sha;
		} catch (err) {
			void err; // torn/foreign line — skipping is this reader's contract
		}
	}
	if (!sha) return null;
	const blobPath = join(stateDir(cwd), "blobs", `${sha}.json.gz`);
	if (!existsSync(blobPath)) return null;
	try {
		const parsed = JSON.parse(gunzipSync(readFileSync(blobPath)).toString("utf-8")) as HarnessStateSnapshot;
		return parsed && parsed.schema === "state-snapshot.v1" ? parsed : null;
	} catch (err) {
		void err; // corrupt blob — treat as absent rather than throwing on restore probes
		return null;
	}
}
