// Tests for the coverage-index persistent store — pins the section 8.2 layout
// (per-runner subtree, contribution blobs + checksums, manifest generations)
// and the section 12 atomicity requirements (CAS promotion, torn data reads as
// absent, accepted state never corrupted).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { staleShards } from "./invalidation.js";
import {
	contributionFromJson,
	contributionToJson,
	promoteManifest,
	readAcceptedManifest,
	readContributionBlob,
	storeDirFor,
	writeContributionBlob,
} from "./store.js";
import type {
	CanonicalCoverageElementSet,
	CoverageIndexManifest,
	ShardCoverageContribution,
} from "./types.js";

let root: string;
let storeDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-index-store-"));
	storeDir = storeDirFor(root, "vitest");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function sampleSet(): CanonicalCoverageElementSet {
	return {
		lines: new Map([
			[1, 2],
			[2, 0],
		]),
		branches: new Map([["1:0:0", 1]]),
		functions: new Map([["f@1", 3]]),
		statements: new Map([["0:0", 1]]),
	};
}

function sampleContribution(shardId = "tests/a.test.ts"): ShardCoverageContribution {
	return {
		shardId,
		files: new Map([
			["src/m.ts", sampleSet()],
			["src/other.ts", { lines: new Map([[7, 1]]), branches: new Map(), functions: new Map() }],
		]),
	};
}

function sampleManifest(generation: number): CoverageIndexManifest {
	return {
		version: 1,
		generation,
		authoritativeAt: "2026-06-11T00:00:00.000Z",
		runnerId: "vitest",
		runnerVersion: "4.1.8",
		coverageEngine: "v8",
		coverageConfigHash: "cfg-hash",
		testDiscoveryHash: "disc-hash",
		dependencyGraphVersion: "g1",
		environmentHash: "env-hash",
		shardBoundary: "file",
		shards: {},
	};
}

describe("storeDirFor", () => {
	it("nests one subtree per runner under .interlinked/coverage-index", () => {
		expect(storeDirFor("/repo", "vitest")).toBe("/repo/.interlinked/coverage-index/vitest");
		expect(storeDirFor("/repo", "coverage-py")).toBe(
			"/repo/.interlinked/coverage-index/coverage-py",
		);
	});
});

describe("contribution JSON round-trip", () => {
	it("serializes and revives Maps losslessly, including optional statements", () => {
		const original = sampleContribution();
		const revived = contributionFromJson(contributionToJson(original));
		expect(revived).not.toBeNull();
		expect(revived?.shardId).toBe(original.shardId);
		expect(revived?.files.get("src/m.ts")?.lines).toEqual(original.files.get("src/m.ts")?.lines);
		expect(revived?.files.get("src/m.ts")?.statements).toEqual(
			original.files.get("src/m.ts")?.statements,
		);
		// A file without statements stays without them (exact optional semantics).
		expect(revived?.files.get("src/other.ts")?.statements).toBeUndefined();
	});

	it("rejects malformed payloads instead of throwing", () => {
		expect(contributionFromJson(null)).toBeNull();
		expect(contributionFromJson({ version: 99 })).toBeNull();
		expect(contributionFromJson({ version: 1, shardId: 5, files: [] })).toBeNull();
		expect(contributionFromJson({ version: 1, shardId: "s", files: "nope" })).toBeNull();
	});
});

describe("contribution blobs", () => {
	it("writes a compressed blob and reads it back through its checksum", () => {
		const contribution = sampleContribution();
		const entry = writeContributionBlob(storeDir, contribution);
		expect(entry).not.toBeNull();
		expect(entry?.contributionPath.startsWith("shards/")).toBe(true);
		const revived = readContributionBlob(storeDir, entry as NonNullable<typeof entry>);
		expect(revived?.shardId).toBe(contribution.shardId);
		expect(revived?.files.get("src/m.ts")?.lines.get(1)).toBe(2);
	});

	it("distinct shard ids get distinct blob paths", () => {
		const a = writeContributionBlob(storeDir, sampleContribution("tests/a.test.ts"));
		const b = writeContributionBlob(storeDir, sampleContribution("tests/b.test.ts"));
		expect(a?.contributionPath).not.toBe(b?.contributionPath);
	});

	it("a corrupted blob reads as null (checksum mismatch), never throws", () => {
		const entry = writeContributionBlob(storeDir, sampleContribution());
		if (!entry) throw new Error("write failed");
		writeFileSync(join(storeDir, entry.contributionPath), "garbage-not-gzip", "utf-8");
		expect(readContributionBlob(storeDir, entry)).toBeNull();
	});

	it("a checksum-tampered entry reads as null even when the blob is intact", () => {
		const entry = writeContributionBlob(storeDir, sampleContribution());
		if (!entry) throw new Error("write failed");
		expect(
			readContributionBlob(storeDir, { ...entry, contributionChecksum: "0".repeat(64) }),
		).toBeNull();
	});

	it("a missing blob reads as null", () => {
		expect(
			readContributionBlob(storeDir, {
				contributionPath: "shards/missing.json.gz",
				contributionChecksum: "0".repeat(64),
			}),
		).toBeNull();
	});

	it("leaves no temp files behind after writing", () => {
		writeContributionBlob(storeDir, sampleContribution());
		const leftovers = readdirSync(join(storeDir, "shards")).filter((f) => f.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});
});

describe("manifest read + CAS promotion (section 12)", () => {
	it("reads null when no manifest exists yet", () => {
		expect(readAcceptedManifest(storeDir)).toBeNull();
	});

	it("first promotion expects generation null and lands generation 1", () => {
		const ok = promoteManifest(storeDir, sampleManifest(1), null);
		expect(ok).toBe(true);
		expect(readAcceptedManifest(storeDir)?.generation).toBe(1);
	});

	it("a stale expected generation is rejected and the accepted manifest is untouched", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		promoteManifest(storeDir, sampleManifest(2), 1);
		// A racer still holding generation 1 as its parent must lose.
		const stale = promoteManifest(storeDir, { ...sampleManifest(2), runnerVersion: "9.9.9" }, 1);
		expect(stale).toBe(false);
		expect(readAcceptedManifest(storeDir)?.generation).toBe(2);
		expect(readAcceptedManifest(storeDir)?.runnerVersion).toBe("4.1.8");
	});

	it("a promotion whose generation is not expected+1 is rejected", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		expect(promoteManifest(storeDir, sampleManifest(5), 1)).toBe(false);
	});

	it("a malformed manifest on disk reads as null (fail-open) and can be re-initialized", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		writeFileSync(join(storeDir, "manifest.json"), "{ torn", "utf-8");
		expect(readAcceptedManifest(storeDir)).toBeNull();
		// Re-initialization treats the torn store as empty.
		expect(promoteManifest(storeDir, sampleManifest(1), null)).toBe(true);
		expect(readAcceptedManifest(storeDir)?.generation).toBe(1);
	});

	it("manifest writes are atomic — no temp files left behind", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		const leftovers = readdirSync(storeDir).filter((f) => f.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("manifest round-trips its shard entries", () => {
		const manifest = sampleManifest(1);
		manifest.shards["tests/a.test.ts"] = {
			shardId: "tests/a.test.ts",
			testPaths: ["tests/a.test.ts"],
			testContentHashes: { "tests/a.test.ts": "abc" },
			dependencyHashes: { "src/m.ts": "def" },
			lastDurationMs: 412,
			contributionPath: "shards/xyz.json.gz",
			contributionChecksum: "0".repeat(64),
			passed: true,
			instability: { events: [], consecutiveStableRuns: 3, quarantined: false },
		};
		promoteManifest(storeDir, manifest, null);
		const read = readAcceptedManifest(storeDir);
		expect(read?.shards["tests/a.test.ts"]?.lastDurationMs).toBe(412);
		expect(read?.shards["tests/a.test.ts"]?.instability.quarantined).toBe(false);
	});

	// Round 7 (finding 2026-06): a top-level-only object check let a manifest
	// with a corrupt shard entry through, and the first consumer to iterate it
	// threw instead of degrading to the full-run fallback. Each entry is now
	// validated at the read boundary.
	const okEntry = {
		shardId: "s",
		testPaths: [] as unknown[],
		testContentHashes: {} as Record<string, unknown>,
		dependencyHashes: {},
		lastDurationMs: 0,
		contributionPath: "p",
		contributionChecksum: "c",
		passed: null,
		instability: {},
	};
	const MALFORMED_MANIFESTS: Array<[string, Record<string, unknown>]> = [
		["a null shard entry ({shards:{bad:null}})", { bad: null }],
		["a non-object shard entry", { bad: 42 }],
		["an entry missing testContentHashes", { s: { ...okEntry, testContentHashes: undefined } }],
		["an entry whose testPaths is not a string array", { s: { ...okEntry, testPaths: [7] } }],
		["an entry whose hash map has a non-string value", { s: { ...okEntry, testContentHashes: { a: 1 } } }],
	];

	it.each(MALFORMED_MANIFESTS)(
		"rejects %s → null (full-run fallback, never an exception)",
		(_label, shards) => {
			promoteManifest(storeDir, sampleManifest(1), null); // creates the store dir
			const manifest = { ...sampleManifest(1), shards };
			writeFileSync(join(storeDir, "manifest.json"), JSON.stringify(manifest), "utf-8");
			expect(readAcceptedManifest(storeDir)).toBeNull();
		},
	);

	it("still accepts a well-formed entry (the guard does not over-reject)", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		const manifest = { ...sampleManifest(1), shards: { s: { ...okEntry, testPaths: ["t"] } } };
		writeFileSync(join(storeDir, "manifest.json"), JSON.stringify(manifest), "utf-8");
		expect(readAcceptedManifest(storeDir)?.shards.s?.shardId).toBe("s");
	});

	it("a corrupt shard entry degrades staleShards to no-op instead of throwing (the reported crash)", () => {
		promoteManifest(storeDir, sampleManifest(1), null);
		writeFileSync(
			join(storeDir, "manifest.json"),
			JSON.stringify({ ...sampleManifest(1), shards: { bad: null } }),
			"utf-8",
		);
		const manifest = readAcceptedManifest(storeDir);
		expect(manifest).toBeNull();
		// The consumer is only ever handed a validated manifest; with null it is
		// not called — no Object.entries(null) TypeError reaches the gate.
		expect(() => (manifest ? staleShards(manifest, storeDir) : [])).not.toThrow();
	});
});

describe("blob + manifest integration", () => {
	it("a full write→manifest→read cycle revives the exact contribution", () => {
		const contribution = sampleContribution();
		const entry = writeContributionBlob(storeDir, contribution);
		if (!entry) throw new Error("write failed");
		const manifest = sampleManifest(1);
		manifest.shards[contribution.shardId] = {
			shardId: contribution.shardId,
			testPaths: [contribution.shardId],
			testContentHashes: {},
			dependencyHashes: {},
			lastDurationMs: 100,
			...entry,
			passed: true,
			instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
		};
		promoteManifest(storeDir, manifest, null);

		const read = readAcceptedManifest(storeDir);
		const shardEntry = read?.shards[contribution.shardId];
		expect(shardEntry).toBeDefined();
		const revived = readContributionBlob(storeDir, shardEntry as NonNullable<typeof shardEntry>);
		expect(revived?.files.get("src/m.ts")?.branches.get("1:0:0")).toBe(1);
	});

	it("store files stay inside the per-runner subtree", () => {
		writeContributionBlob(storeDir, sampleContribution());
		promoteManifest(storeDir, sampleManifest(1), null);
		expect(existsSync(join(root, ".interlinked/coverage-index/vitest/manifest.json"))).toBe(true);
		expect(readFileSync(join(storeDir, "manifest.json"), "utf-8")).toContain('"runnerId": "vitest"');
	});
});
