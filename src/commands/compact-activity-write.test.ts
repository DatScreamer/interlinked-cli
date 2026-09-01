import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileIdentity } from "../lib/file-suffix-replacement.js";
import { sha256File } from "../lib/bounded-file-io.js";
import type { JsonObject } from "../lib/json-types.js";
import {
	resumePendingActivityRotation,
	rotateActivityPrefix,
} from "./compact-activity-write.js";
import type { ArchiveManifest } from "./compact-plain.js";
import {
	createRotationClaim,
	rotationClaimPath,
} from "./compact-rotation-claim.js";

describe("activity rotation — append safety and crash recovery", () => {
	let root: string;
	let dataDir: string;
	let archiveDir: string;
	let activityPath: string;
	let syncStatePath: string;
	let manifestPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-activity-rotation-"));
		dataDir = join(root, ".interlinked");
		archiveDir = join(dataDir, "archive");
		activityPath = join(dataDir, "activity.jsonl");
		syncStatePath = join(dataDir, "sync-state.json");
		manifestPath = join(archiveDir, "manifest.json");
		mkdirSync(archiveDir, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function loadManifest(): ArchiveManifest {
		if (!existsSync(manifestPath)) return { version: 1, segments: [] };
		return JSON.parse(readFileSync(manifestPath, "utf8")) as ArchiveManifest;
	}

	it("preserves an append injected after the suffix copy and before pathname replacement", () => {
		const original = "first\nsecond\ntail\n";
		const late = "late\n";
		writeFileSync(activityPath, original);
		const syncState: JsonObject = { synced_through_bytes: Buffer.byteLength(original) };
		writeFileSync(syncStatePath, JSON.stringify(syncState));

		const result = rotateActivityPrefix({
			activityPath,
			syncStatePath,
			archiveDir,
			manifestPath,
			cutByte: Buffer.byteLength("first\nsecond\n"),
			records: 2,
			syncedBytes: Buffer.byteLength(original),
			source: fileIdentity(activityPath),
			syncState,
			loadManifest,
			nextSequence: () => 1,
			afterInitialCopy: () => appendFileSync(activityPath, late),
		});
		expect("segmentFile" in result).toBe(false);
		if ("segmentFile" in result) throw new Error(result.reason);

		const archived = gunzipSync(
			readFileSync(join(archiveDir, result.segment.file)),
		).toString("utf8");
		const live = readFileSync(activityPath, "utf8");
		expect(archived + live).toBe(original + late);
		expect(live).toBe(`tail\n${late}`);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeUndefined();
	});

	it("preserves a private activity log mode on both the archive and live suffix", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		chmodSync(activityPath, 0o600);
		const syncState: JsonObject = { synced_through_bytes: Buffer.byteLength(original) };
		writeFileSync(syncStatePath, JSON.stringify(syncState));

		const result = rotateActivityPrefix({
			activityPath,
			syncStatePath,
			archiveDir,
			manifestPath,
			cutByte: Buffer.byteLength(prefix),
			records: 2,
			syncedBytes: Buffer.byteLength(original),
			source: fileIdentity(activityPath),
			syncState,
			loadManifest,
			nextSequence: () => 1,
		});
		if ("segmentFile" in result) throw new Error(result.reason);

		expect(statSync(activityPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(archiveDir, result.segment.file)).mode & 0o777).toBe(0o600);
	});

	it("finishes an indexed-but-untruncated prefix without archiving it twice", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		writeFileSync(activityPath, `${prefix}${tail}`);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: prefix.length + tail.length }));
		writeFileSync(join(archiveDir, "activity-0001.jsonl.gz"), gzipSync(prefix));
		const segment = {
			seq: 1,
			file: "activity-0001.jsonl.gz",
			bytes: Buffer.byteLength(prefix),
			gz_bytes: gzipSync(prefix).length,
			records: 2,
			created_at: "2026-08-31T00:00:00.000Z",
			pending_live_drop: {
				cut_bytes: Buffer.byteLength(prefix),
				source: fileIdentity(activityPath),
				replacement: { dev: "0", ino: "0" },
				synced_through_bytes: Buffer.byteLength(tail),
			},
		};
		writeFileSync(manifestPath, JSON.stringify({ version: 1, segments: [segment] }));
		const syncState: JsonObject = { synced_through_bytes: prefix.length + tail.length };

		const result = resumePendingActivityRotation(
			{
				activityPath,
				archiveDir,
				syncStatePath,
				manifestPath,
				syncState,
				loadManifest,
			},
			false,
		);

		expect(result?.recovered).toBe(true);
		expect(result?.segment.file).toBe("activity-0001.jsonl.gz");
		expect(readFileSync(activityPath, "utf8")).toBe(tail);
		expect(loadManifest().segments).toHaveLength(1);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeUndefined();
		expect(JSON.parse(readFileSync(syncStatePath, "utf8"))).toMatchObject({
			synced_through_bytes: Buffer.byteLength(tail),
		});
	});

	it("refuses a claim-less pending cursor beyond the retained suffix before any write", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: original.length }));
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const replacementProbe = join(dataDir, ".replacement-probe");
		writeFileSync(replacementProbe, tail);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: Buffer.byteLength(prefix),
					gz_bytes: readFileSync(segmentPath).length,
					records: 2,
					created_at: "2026-08-31T00:00:00.000Z",
					pending_live_drop: {
						cut_bytes: Buffer.byteLength(prefix),
						source: fileIdentity(activityPath),
						replacement: fileIdentity(replacementProbe),
						synced_through_bytes: 999_999,
					},
				}],
			}),
		);
		const manifestBefore = readFileSync(manifestPath);
		const syncBefore = readFileSync(syncStatePath);

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: original.length },
					loadManifest,
				},
				false,
			),
		).toThrow(/sync cursor 999999 exceeds 5 retained activity bytes/);
		expect(readFileSync(activityPath, "utf8")).toBe(original);
		expect(readFileSync(manifestPath).equals(manifestBefore)).toBe(true);
		expect(readFileSync(syncStatePath).equals(syncBefore)).toBe(true);
	});

	it("refuses a claimed source cursor beyond the retained suffix and preserves the claim", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: original.length }));
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const replacementProbe = join(dataDir, ".replacement-probe");
		writeFileSync(replacementProbe, tail);
		createRotationClaim(archiveDir, {
			version: 1,
			log: "activity",
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 2,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: "2026-08-31T00:00:00.000Z",
			source: fileIdentity(activityPath),
			replacement: fileIdentity(replacementProbe),
			synced_through_bytes: 999_999,
		});
		const claimPath = rotationClaimPath(archiveDir, "activity");
		const claimBefore = readFileSync(claimPath);
		const syncBefore = readFileSync(syncStatePath);

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: original.length },
					loadManifest,
				},
				false,
			),
		).toThrow(/sync cursor 999999 exceeds 5 retained activity bytes/);
		expect(readFileSync(activityPath, "utf8")).toBe(original);
		expect(readFileSync(claimPath).equals(claimBefore)).toBe(true);
		expect(readFileSync(syncStatePath).equals(syncBefore)).toBe(true);
		expect(existsSync(manifestPath)).toBe(false);
	});

	it("refuses a pending segment whose gzip does not contain the live prefix", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: original.length }));
		const badGzip = gzipSync("not-the-live-prefix\n");
		writeFileSync(join(archiveDir, "activity-0001.jsonl.gz"), badGzip);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: Buffer.byteLength(prefix),
					gz_bytes: badGzip.length,
					records: 2,
					created_at: "2026-08-31T00:00:00.000Z",
					pending_live_drop: {
						cut_bytes: Buffer.byteLength(prefix),
						source: fileIdentity(activityPath),
						replacement: { dev: "0", ino: "0" },
						synced_through_bytes: Buffer.byteLength(tail),
					},
				}],
			}),
		);
		const syncState: JsonObject = { synced_through_bytes: original.length };

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState,
					loadManifest,
				},
				false,
			),
		).toThrow(/does not match the live prefix/);
		expect(readFileSync(activityPath, "utf8")).toBe(original);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeDefined();
		expect(syncState.synced_through_bytes).toBe(original.length);
	});

	it("does not finalize a claim-less pending row after the live prefix is already gone", () => {
		const liveTail = "tail\n";
		writeFileSync(activityPath, liveTail);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: 0 }));
		const archived = gzipSync("first\nsecond\n");
		writeFileSync(join(archiveDir, "activity-0001.jsonl.gz"), archived);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: 13,
					gz_bytes: archived.length,
					records: 2,
					created_at: "2026-08-31T00:00:00.000Z",
					pending_live_drop: {
						cut_bytes: 13,
						source: { dev: "0", ino: "0" },
						replacement: fileIdentity(activityPath),
						synced_through_bytes: 0,
					},
				}],
			}),
		);

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: 0 },
					loadManifest,
				},
				false,
			),
		).toThrow(/has no durable claim/);
		expect(readFileSync(activityPath, "utf8")).toBe(liveTail);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeDefined();
	});

	it("refuses a durable claim that disagrees with its pending manifest", () => {
		const prefix = "first\nsecond\n";
		const tail = "tail\n";
		const original = `${prefix}${tail}`;
		writeFileSync(activityPath, original);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: original.length }));
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const replacementProbe = join(dataDir, ".replacement-probe");
		writeFileSync(replacementProbe, tail);
		const source = fileIdentity(activityPath);
		const replacement = fileIdentity(replacementProbe);
		const createdAt = "2026-08-31T00:00:00.000Z";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: Buffer.byteLength(prefix),
					gz_bytes: readFileSync(segmentPath).length,
					records: 2,
					created_at: createdAt,
					pending_live_drop: {
						cut_bytes: Buffer.byteLength(prefix),
						source,
						replacement,
						synced_through_bytes: Buffer.byteLength(tail),
					},
				}],
			}),
		);
		createRotationClaim(archiveDir, {
			version: 1,
			log: "activity",
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 99,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: createdAt,
			source,
			replacement,
			synced_through_bytes: Buffer.byteLength(tail),
		});

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: original.length },
					loadManifest,
				},
				false,
			),
		).toThrow(/does not match its pending manifest and durable claim/);
		expect(readFileSync(activityPath, "utf8")).toBe(original);
		expect(existsSync(rotationClaimPath(archiveDir, "activity"))).toBe(true);
		expect(loadManifest().segments[0]?.pending_live_drop).toBeDefined();
	});

	it("does not remove a claim when a complete manifest row contradicts it", () => {
		const prefix = "first\nsecond\n";
		const liveTail = "tail\n";
		writeFileSync(activityPath, liveTail);
		writeFileSync(syncStatePath, JSON.stringify({ synced_through_bytes: 0 }));
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		writeFileSync(segmentPath, gzipSync(prefix));
		const createdAt = "2026-08-31T00:00:00.000Z";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "activity-0001.jsonl.gz",
					bytes: Buffer.byteLength(prefix),
					gz_bytes: readFileSync(segmentPath).length,
					records: 999,
					created_at: createdAt,
				}],
			}),
		);
		createRotationClaim(archiveDir, {
			version: 1,
			log: "activity",
			seq: 1,
			file: "activity-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 2,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: createdAt,
			source: { dev: "0", ino: "0" },
			replacement: fileIdentity(activityPath),
			synced_through_bytes: 0,
		});

		expect(() =>
			resumePendingActivityRotation(
				{
					activityPath,
					archiveDir,
					syncStatePath,
					manifestPath,
					syncState: { synced_through_bytes: 0 },
					loadManifest,
				},
				false,
			),
		).toThrow(/does not match its durable rotation claim/);
		expect(readFileSync(activityPath, "utf8")).toBe(liveTail);
		expect(existsSync(rotationClaimPath(archiveDir, "activity"))).toBe(true);
		expect(loadManifest().segments[0]?.records).toBe(999);
	});
});
