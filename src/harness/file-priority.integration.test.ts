import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process + fs BEFORE importing the module under test. file-priority
// reaches for spawnSync (git log) and the four fs primitives at call time;
// mocking them here keeps every test deterministic and host-independent.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(() => ""),
	writeFileSync: vi.fn(),
}));

import { spawnSync as mockedSpawnSync } from "node:child_process";
import {
	existsSync as mockedExistsSync,
	mkdirSync as mockedMkdirSync,
	readFileSync as mockedReadFileSync,
	writeFileSync as mockedWriteFileSync,
} from "node:fs";
import { nonNull } from "../lib/non-null.js";
import {
	computeFilePriority,
	type FilePriority,
	HOT_DAYS_MAX,
	loadPriorityCache,
	PRIORITY_TTL_MS,
	type PriorityCache,
	parseGitLogOutput,
	priorityTierForAge,
	refreshPriorityIfStale,
	savePriorityCache,
	shouldRunAdvisoryChecks,
	WARM_DAYS_MAX,
} from "./file-priority.js";

const spawnSyncMock = vi.mocked(mockedSpawnSync);
const existsSyncMock = vi.mocked(mockedExistsSync);
const mkdirSyncMock = vi.mocked(mockedMkdirSync);
const readFileSyncMock = vi.mocked(mockedReadFileSync);
const writeFileSyncMock = vi.mocked(mockedWriteFileSync);

/** Build a SpawnSyncReturns<string>, omitting `error` when absent so the
 *  literal satisfies exactOptionalPropertyTypes without an `undefined` key. */
function mkSpawnResult(opts: {
	status?: number | null;
	stdout?: string;
	stderr?: string;
	error?: NodeJS.ErrnoException;
}): SpawnSyncReturns<string> {
	const status = opts.status === undefined ? 0 : opts.status;
	const stdout = opts.stdout ?? "";
	const stderr = opts.stderr ?? "";
	const base: SpawnSyncReturns<string> = {
		pid: 42,
		output: [null, stdout, stderr],
		stdout,
		stderr,
		status,
		signal: null,
	};
	return opts.error ? { ...base, error: opts.error } : base;
}

/** A fixed "now" so age math is exact across runs. */
const NOW = Date.parse("2026-06-06T00:00:00.000Z");
/** Helper: a unix-second timestamp `days` before NOW. */
function tsDaysAgo(days: number): number {
	return Math.round((NOW - days * 86_400_000) / 1000);
}

beforeEach(() => {
	spawnSyncMock.mockReset();
	existsSyncMock.mockReset();
	existsSyncMock.mockReturnValue(false);
	mkdirSyncMock.mockReset();
	readFileSyncMock.mockReset();
	readFileSyncMock.mockReturnValue("");
	writeFileSyncMock.mockReset();
});

// ---------------------------------------------------------------------------
// priorityTierForAge — every threshold branch + boundaries
// ---------------------------------------------------------------------------
describe("priorityTierForAge", () => {
	it("classifies negative (unknown) age as cold", () => {
		expect(priorityTierForAge(-1)).toBe("cold");
		expect(priorityTierForAge(-9999)).toBe("cold");
	});

	it("classifies age below the hot cutoff as hot", () => {
		expect(priorityTierForAge(0)).toBe("hot");
		expect(priorityTierForAge(HOT_DAYS_MAX - 1)).toBe("hot");
	});

	it("treats the hot cutoff itself as warm (strict <)", () => {
		// 7 is NOT < 7, but IS <= 180 → warm.
		expect(priorityTierForAge(HOT_DAYS_MAX)).toBe("warm");
	});

	it("classifies the inclusive warm range as warm", () => {
		expect(priorityTierForAge(30)).toBe("warm");
		expect(priorityTierForAge(WARM_DAYS_MAX)).toBe("warm");
	});

	it("classifies age above the warm cutoff as cold", () => {
		expect(priorityTierForAge(WARM_DAYS_MAX + 1)).toBe("cold");
		expect(priorityTierForAge(10_000)).toBe("cold");
	});

	it("exposes the documented threshold constants", () => {
		expect(HOT_DAYS_MAX).toBe(7);
		expect(WARM_DAYS_MAX).toBe(180);
		expect(PRIORITY_TTL_MS).toBe(24 * 60 * 60 * 1000);
	});
});

// ---------------------------------------------------------------------------
// parseGitLogOutput — block splitting, ts validation, dedup, clamp
// ---------------------------------------------------------------------------
describe("parseGitLogOutput", () => {
	it("parses a single block into per-file entries with derived tiers", () => {
		const stdout = `${tsDaysAgo(2)}\nsrc/a.ts\nsrc/b.ts`;
		const map = parseGitLogOutput(stdout, NOW);
		expect(map.get("src/a.ts")).toEqual<FilePriority>({
			ageDays: 2,
			tier: "hot",
		});
		expect(map.get("src/b.ts")).toEqual<FilePriority>({
			ageDays: 2,
			tier: "hot",
		});
	});

	it("keeps the most-recent (first) occurrence of a repeated path", () => {
		// Block 1 (recent, 2 days) then block 2 (old, 300 days) both touch a.ts.
		const stdout = [
			`${tsDaysAgo(2)}`,
			"src/a.ts",
			"",
			`${tsDaysAgo(300)}`,
			"src/a.ts",
			"src/old.ts",
		].join("\n");
		const map = parseGitLogOutput(stdout, NOW);
		// a.ts wins from the first (recent) block → still hot.
		expect(map.get("src/a.ts")).toEqual<FilePriority>({
			ageDays: 2,
			tier: "hot",
		});
		// old.ts only appears in the old block → cold.
		expect(map.get("src/old.ts")).toEqual<FilePriority>({
			ageDays: 300,
			tier: "cold",
		});
	});

	it("derives warm for files in the warm age band", () => {
		const stdout = `${tsDaysAgo(90)}\nsrc/warm.ts`;
		const map = parseGitLogOutput(stdout, NOW);
		expect(map.get("src/warm.ts")).toEqual<FilePriority>({
			ageDays: 90,
			tier: "warm",
		});
	});

	it("skips empty blocks and blank lines between groups", () => {
		const stdout = `\n\n   \n\n${tsDaysAgo(1)}\nsrc/a.ts\n\n\n`;
		const map = parseGitLogOutput(stdout, NOW);
		expect(map.size).toBe(1);
		expect(map.get("src/a.ts")?.ageDays).toBe(1);
	});

	it("skips a block whose timestamp is non-numeric", () => {
		const stdout = "not-a-number\nsrc/a.ts";
		const map = parseGitLogOutput(stdout, NOW);
		expect(map.size).toBe(0);
	});

	it("skips a block whose timestamp is zero or negative", () => {
		const stdout = ["0", "src/zero.ts", "", "-5", "src/neg.ts"].join("\n");
		const map = parseGitLogOutput(stdout, NOW);
		expect(map.has("src/zero.ts")).toBe(false);
		expect(map.has("src/neg.ts")).toBe(false);
		expect(map.size).toBe(0);
	});

	it("treats a whitespace-only line as a block separator", () => {
		// `\n   \n` matches the block delimiter /\n\s*\n/, so the run splits
		// into two blocks: a valid one (a.ts @ 3d) and `src/b.ts` alone — whose
		// first line ("src/b.ts") parses as NaN → dropped. Only a.ts survives.
		const stdout = `${tsDaysAgo(3)}\nsrc/a.ts\n   \nsrc/b.ts`;
		const map = parseGitLogOutput(stdout, NOW);
		expect(map.size).toBe(1);
		expect(map.get("src/a.ts")).toEqual<FilePriority>({
			ageDays: 3,
			tier: "hot",
		});
		expect(map.has("src/b.ts")).toBe(false);
	});

	it("clamps a future commit timestamp to age 0 (hot)", () => {
		// Commit 5 days in the FUTURE → (now - commitMs) negative → Math.max(0).
		const stdout = `${tsDaysAgo(-5)}\nsrc/future.ts`;
		const map = parseGitLogOutput(stdout, NOW);
		expect(map.get("src/future.ts")).toEqual<FilePriority>({
			ageDays: 0,
			tier: "hot",
		});
	});

	it("returns an empty map for empty stdout", () => {
		expect(parseGitLogOutput("", NOW).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// shouldRunAdvisoryChecks — fail-open + cold gate
// ---------------------------------------------------------------------------
describe("shouldRunAdvisoryChecks", () => {
	const map = new Map<string, FilePriority>([
		["hot.ts", { ageDays: 1, tier: "hot" }],
		["warm.ts", { ageDays: 90, tier: "warm" }],
		["cold.ts", { ageDays: 400, tier: "cold" }],
	]);

	it("fails open (true) for untracked / unmapped files", () => {
		expect(shouldRunAdvisoryChecks("brand-new.ts", map)).toBe(true);
		expect(shouldRunAdvisoryChecks("anything", new Map())).toBe(true);
	});

	it("returns true for hot files", () => {
		expect(shouldRunAdvisoryChecks("hot.ts", map)).toBe(true);
	});

	it("returns true for warm files", () => {
		expect(shouldRunAdvisoryChecks("warm.ts", map)).toBe(true);
	});

	it("returns false for cold files", () => {
		expect(shouldRunAdvisoryChecks("cold.ts", map)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// computeFilePriority — git invocation + failure modes
// ---------------------------------------------------------------------------
describe("computeFilePriority", () => {
	it("invokes git log with the expected args and parses success output", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 0, stdout: `${tsDaysAgo(1)}\nsrc/a.ts` }),
		);
		const map = computeFilePriority("/repo", NOW);
		expect(map.get("src/a.ts")?.tier).toBe("hot");

		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [bin, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(bin).toBe("git");
		expect(args).toEqual([
			"-C",
			"/repo",
			"log",
			"--format=%ct",
			"--name-only",
			"--since=365 days ago",
		]);
		expect(opts).toMatchObject({ encoding: "utf-8", timeout: 30_000 });
	});

	it("returns an empty map when git exits non-zero", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 1, stdout: `${tsDaysAgo(1)}\nsrc/a.ts` }),
		);
		expect(computeFilePriority("/repo", NOW).size).toBe(0);
	});

	it("returns an empty map when git produces no stdout", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0, stdout: "" }));
		expect(computeFilePriority("/repo", NOW).size).toBe(0);
	});

	it("returns an empty map when spawn fails (status null, e.g. ENOENT)", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: null,
				error: Object.assign(new Error("spawn git ENOENT"), {
					code: "ENOENT",
				}),
			}),
		);
		expect(computeFilePriority("/repo", NOW).size).toBe(0);
	});

	it("defaults `now` to Date.now() when omitted", () => {
		const before = Date.now();
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 0,
				// Commit "now-ish" → age 0/1, definitively hot regardless of skew.
				stdout: `${Math.round(before / 1000)}\nsrc/now.ts`,
			}),
		);
		const map = computeFilePriority("/repo");
		expect(map.get("src/now.ts")?.tier).toBe("hot");
	});
});

// ---------------------------------------------------------------------------
// loadPriorityCache — absent / malformed / valid + ternary
// ---------------------------------------------------------------------------
describe("loadPriorityCache", () => {
	it("returns null when the cache file is absent", () => {
		existsSyncMock.mockReturnValue(false);
		expect(loadPriorityCache("/repo")).toBeNull();
		expect(readFileSyncMock).not.toHaveBeenCalled();
	});

	it("returns a normalized cache for a well-formed file", () => {
		const cache: PriorityCache = {
			version: 1,
			computedAt: 1_700_000_000_000,
			files: { "src/a.ts": { ageDays: 3, tier: "hot" } },
		};
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(JSON.stringify(cache));
		expect(loadPriorityCache("/repo")).toEqual(cache);
	});

	it("defaults computedAt to 0 when it is not a number", () => {
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(
			JSON.stringify({ version: 1, computedAt: "soon", files: {} }),
		);
		const loaded = loadPriorityCache("/repo");
		expect(loaded).toEqual<PriorityCache>({
			version: 1,
			computedAt: 0,
			files: {},
		});
	});

	it("returns null when the parsed JSON is not an object", () => {
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue("42");
		expect(loadPriorityCache("/repo")).toBeNull();
	});

	it("returns null when the parsed JSON is literally null", () => {
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue("null");
		expect(loadPriorityCache("/repo")).toBeNull();
	});

	it("returns null on a version mismatch", () => {
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(
			JSON.stringify({ version: 2, computedAt: 1, files: {} }),
		);
		expect(loadPriorityCache("/repo")).toBeNull();
	});

	it("returns null when files is not an object", () => {
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(
			JSON.stringify({ version: 1, computedAt: 1, files: "nope" }),
		);
		expect(loadPriorityCache("/repo")).toBeNull();
	});

	it("returns null when files is null (falsy guard)", () => {
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(
			'{"version":1,"computedAt":1,"files":null}',
		);
		expect(loadPriorityCache("/repo")).toBeNull();
	});

	it("returns null when the file content is invalid JSON (catch branch)", () => {
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue("{ not json ]");
		expect(loadPriorityCache("/repo")).toBeNull();
	});

	it("returns null when readFileSync throws (catch branch)", () => {
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockImplementation(() => {
			throw new Error("EACCES");
		});
		expect(loadPriorityCache("/repo")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// savePriorityCache — dir-create branch + write payload
// ---------------------------------------------------------------------------
describe("savePriorityCache", () => {
	const cache: PriorityCache = {
		version: 1,
		computedAt: NOW,
		files: { "src/a.ts": { ageDays: 1, tier: "hot" } },
	};

	it("creates the .interlinked dir when absent, then writes pretty JSON", () => {
		existsSyncMock.mockReturnValue(false);
		savePriorityCache("/repo", cache);

		expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
		const [dirArg, mkOpts] = nonNull(mkdirSyncMock.mock.calls[0]);
		expect(String(dirArg).endsWith("/.interlinked")).toBe(true);
		expect(mkOpts).toEqual({ recursive: true });

		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		const [pathArg, payload] = nonNull(writeFileSyncMock.mock.calls[0]);
		expect(String(pathArg).endsWith("/.interlinked/file-priority.json")).toBe(
			true,
		);
		// Trailing newline + round-trippable content.
		expect(String(payload).endsWith("}\n")).toBe(true);
		expect(JSON.parse(String(payload))).toEqual(cache);
	});

	it("skips mkdir when the directory already exists", () => {
		existsSyncMock.mockReturnValue(true);
		savePriorityCache("/repo", cache);
		expect(mkdirSyncMock).not.toHaveBeenCalled();
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// refreshPriorityIfStale — fresh-cache hit vs stale/missing recompute
// ---------------------------------------------------------------------------
describe("refreshPriorityIfStale", () => {
	it("returns the cached map untouched when the cache is fresh", () => {
		const cache: PriorityCache = {
			version: 1,
			computedAt: NOW - 1000, // 1s old, well within TTL
			files: { "src/cached.ts": { ageDays: 5, tier: "hot" } },
		};
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(JSON.stringify(cache));

		const map = refreshPriorityIfStale("/repo", NOW, PRIORITY_TTL_MS);
		expect(map.get("src/cached.ts")).toEqual<FilePriority>({
			ageDays: 5,
			tier: "hot",
		});
		// Fresh hit → no git, no write.
		expect(spawnSyncMock).not.toHaveBeenCalled();
		expect(writeFileSyncMock).not.toHaveBeenCalled();
	});

	it("recomputes + persists when the cache is stale", () => {
		const stale: PriorityCache = {
			version: 1,
			computedAt: NOW - PRIORITY_TTL_MS - 1, // just past TTL
			files: { "src/old.ts": { ageDays: 5, tier: "hot" } },
		};
		existsSyncMock.mockImplementation((p) =>
			String(p).endsWith("file-priority.json"),
		);
		readFileSyncMock.mockReturnValue(JSON.stringify(stale));
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 0, stdout: `${tsDaysAgo(2)}\nsrc/fresh.ts` }),
		);

		const map = refreshPriorityIfStale("/repo", NOW, PRIORITY_TTL_MS);
		expect(map.get("src/fresh.ts")?.tier).toBe("hot");
		expect(map.has("src/old.ts")).toBe(false); // replaced, not merged
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);

		// Persisted the freshly computed map.
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		const persisted = JSON.parse(String(nonNull(writeFileSyncMock.mock.calls[0])[1]));
		expect(persisted).toMatchObject({
			version: 1,
			computedAt: NOW,
			files: { "src/fresh.ts": { ageDays: 2, tier: "hot" } },
		});
	});

	it("recomputes when no cache exists at all", () => {
		existsSyncMock.mockReturnValue(false);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 0, stdout: `${tsDaysAgo(1)}\nsrc/new.ts` }),
		);

		const map = refreshPriorityIfStale("/repo", NOW, PRIORITY_TTL_MS);
		expect(map.get("src/new.ts")?.tier).toBe("hot");
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
	});

	it("persists an empty map when recompute yields nothing (git failed)", () => {
		existsSyncMock.mockReturnValue(false);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 1 }));

		const map = refreshPriorityIfStale("/repo", NOW, PRIORITY_TTL_MS);
		expect(map.size).toBe(0);
		const persisted = JSON.parse(String(nonNull(writeFileSyncMock.mock.calls[0])[1]));
		expect(persisted.files).toEqual({});
	});

	it("uses default now + ttl when omitted (cache fresh → no recompute)", () => {
		// Cache computed 'now' so it is fresh under the default TTL regardless
		// of the exact Date.now() at call time.
		const cache: PriorityCache = {
			version: 1,
			computedAt: Date.now(),
			files: { "src/d.ts": { ageDays: 0, tier: "hot" } },
		};
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(JSON.stringify(cache));

		const map = refreshPriorityIfStale("/repo");
		expect(map.get("src/d.ts")?.tier).toBe("hot");
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});
