import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as fsMod from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	detectBreakGlass,
	logBreakGlass,
	logPath,
	readBreakGlassLog,
	summarizeBreakGlass,
} from "./break-glass.js";

// break-glass.ts imports readFileSync/mkdirSync directly from "node:fs". To
// observe *whether* those calls happen (the existsSync-guard contract, not
// just the return value), wrap them with vi.fn while delegating to the real
// implementation so every other test in this file still hits the real fs.
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		mkdirSync: vi.fn(actual.mkdirSync),
	};
});

let tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "break-glass-w51-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tmpDirs = [];
	vi.restoreAllMocks();
});

describe("extractReason regex — kills 93a59e48e9f90006, ad45fc3e2f204297", () => {
	// test-contract: public-api — detectBreakGlass's documented contract (docs/design/harness-break-glass-primitive.md) is whitespace-tolerant matching, so multi-space input must still yield a captured reason.
	it("matches across a double space and still captures the trailing reason", () => {
		const result = detectBreakGlass("break  glass: fix this   ");
		expect(result.triggered).toBe(true);
		expect(result.reason).toBe("fix this");
	});

	// test-contract: public-api — the trigger regex itself must tolerate
	// one-or-more whitespace characters between the two words.
	it("triggers on double-space break/glass", () => {
		expect(detectBreakGlass("break  glass").triggered).toBe(true);
	});
});

describe("extractReason trimming and emptiness — kills aad3416287731075, 3285bfa65a13e9cf, c98dfa2645caa8cc", () => {
	// test-contract: public-api — the reason capture is documented as
	// "trimmed"; trailing whitespace at end-of-line must not leak into the
	// returned reason string.
	it("trims trailing whitespace out of the captured reason", () => {
		const result = detectBreakGlass("break glass: fix this   ");
		expect(result.reason).toBe("fix this");
	});

	// test-contract: public-api — an empty reason must normalize to null,
	// not an empty string, per the BreakGlassSignal contract.
	it("returns null reason when nothing follows the token", () => {
		const result = detectBreakGlass("break glass");
		expect(result.reason).toBeNull();
	});
});

describe("logPath — kills 36107d6d63c73ec0", () => {
	// test-contract: public-api — logPath is documented to nest the log
	// under the repo's .interlinked directory; every other consumer
	// (logBreakGlass, readBreakGlassLog) relies on that exact join.
	it("nests the log under .interlinked", () => {
		const cwd = "/some/project";
		expect(logPath(cwd)).toBe(join(cwd, ".interlinked", "break-glass-log.jsonl"));
	});
});

describe("readBreakGlassLog — malformed / typed-field validation", () => {
	// test-contract: boundary — tryParseEntry must reject any JSON value
	// that parses successfully but is not a non-null object (here the JSON
	// literal `null`), and must do so without throwing, since a single
	// malformed line must not crash the whole log read.
	it("returns [] and does not throw on a JSON literal 'null' line", () => {
		const dir = makeTmpDir();
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const path = logPath(dir);
		fsMod.writeFileSync(path, "null\n");
		let result: unknown[] = [];
		expect(() => {
			result = readBreakGlassLog(dir);
		}).not.toThrow();
		expect(result).toEqual([]);
	});

	// test-contract: invariant — BreakGlassEntry.ts must be a string; a
	// well-formed object with the wrong type for `ts` must be filtered out.
	it("rejects an entry whose ts is not a string", () => {
		const dir = makeTmpDir();
		const path = logPath(dir);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		fsMod.writeFileSync(
			path,
			`${JSON.stringify({ ts: 5, user: "u", session_id: "s", tool: "t" })}\n`,
		);
		expect(readBreakGlassLog(dir)).toEqual([]);
	});

	// test-contract: invariant — BreakGlassEntry.user must be a string.
	it("rejects an entry whose user is not a string", () => {
		const dir = makeTmpDir();
		const path = logPath(dir);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		fsMod.writeFileSync(
			path,
			`${JSON.stringify({ ts: "2026-01-01T00:00:00Z", user: 7, session_id: "s", tool: "t" })}\n`,
		);
		expect(readBreakGlassLog(dir)).toEqual([]);
	});

	// test-contract: invariant — BreakGlassEntry.session_id must be a string.
	it("rejects an entry whose session_id is not a string", () => {
		const dir = makeTmpDir();
		const path = logPath(dir);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		fsMod.writeFileSync(
			path,
			`${JSON.stringify({ ts: "2026-01-01T00:00:00Z", user: "u", session_id: 9, tool: "t" })}\n`,
		);
		expect(readBreakGlassLog(dir)).toEqual([]);
	});

	// test-contract: invariant — BreakGlassEntry.tool must be a string.
	it("rejects an entry whose tool is not a string", () => {
		const dir = makeTmpDir();
		const path = logPath(dir);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		fsMod.writeFileSync(
			path,
			`${JSON.stringify({ ts: "2026-01-01T00:00:00Z", user: "u", session_id: "s", tool: 1 })}\n`,
		);
		expect(readBreakGlassLog(dir)).toEqual([]);
	});

	// test-contract: public-api — a valid string `reason` field must be
	// carried through onto the parsed BreakGlassEntry verbatim.
	it("keeps a string reason field verbatim", () => {
		const dir = makeTmpDir();
		const path = logPath(dir);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		fsMod.writeFileSync(
			path,
			`${JSON.stringify({
				ts: "2026-01-01T00:00:00Z",
				user: "u",
				session_id: "s",
				tool: "t",
				reason: "hello",
			})}\n`,
		);
		const entries = readBreakGlassLog(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.reason).toBe("hello");
	});

	// test-contract: public-api — a valid string `commit_sha` field must be
	// carried through onto the parsed BreakGlassEntry verbatim.
	it("keeps a string commit_sha field verbatim", () => {
		const dir = makeTmpDir();
		const path = logPath(dir);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		fsMod.writeFileSync(
			path,
			`${JSON.stringify({
				ts: "2026-01-01T00:00:00Z",
				user: "u",
				session_id: "s",
				tool: "t",
				commit_sha: "abc123",
			})}\n`,
		);
		const entries = readBreakGlassLog(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.commit_sha).toBe("abc123");
	});

	// test-contract: boundary — readBreakGlassLog documents an absent log
	// file as returning [] without attempting to read it; this is an
	// observable I/O contract (no read syscall issued), not just the
	// return value, so we assert on the call itself.
	it("does not call readFileSync when the log file is absent", () => {
		const dir = makeTmpDir();
		vi.mocked(fsMod.readFileSync).mockClear();
		const result = readBreakGlassLog(dir);
		expect(result).toEqual([]);
		expect(fsMod.readFileSync).not.toHaveBeenCalled();
	});
});

describe("summarizeBreakGlass distinct_days — kills e1f8673675be5b8b", () => {
	// test-contract: public-api — BreakGlassStats.distinct_days is
	// documented as the count of distinct CALENDAR DAYS, so two entries on
	// the same day at different times of day must collapse to one.
	it("groups same-day entries with different times into one distinct day", () => {
		const dir = makeTmpDir();
		const path = logPath(dir);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const lines = [
			{ ts: "2026-08-01T10:00:00.000Z", user: "u", session_id: "s1", tool: "t", reason: null, commit_sha: null },
			{ ts: "2026-08-01T15:30:00.000Z", user: "u", session_id: "s2", tool: "t", reason: null, commit_sha: null },
		];
		fsMod.writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		const now = Date.parse("2026-08-02T00:00:00.000Z");
		expect(Number.isFinite(now)).toBe(true);
		const stats = summarizeBreakGlass(dir, 7 * 24 * 60 * 60 * 1000, () => now);
		expect(stats.recent_count).toBe(2);
		expect(stats.distinct_days).toBe(1);
	});
});

describe("logBreakGlass directory creation — kills 4247262abc21fece, f5818f3734fbd01c, 2f960173b6706d0b", () => {
	// test-contract: boundary — ensureDir is documented (by its name and
	// its existsSync guard) to be a no-op when the directory already
	// exists; that no-op is an observable I/O contract, not just an
	// absence of errors.
	it("does not call mkdirSync when the target directory already exists", () => {
		const dir = makeTmpDir();
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		vi.mocked(fsMod.mkdirSync).mockClear();
		logBreakGlass(dir, {
			ts: "2026-01-01T00:00:00Z",
			user: "u",
			session_id: "s",
			tool: "t",
			reason: null,
			commit_sha: null,
		});
		expect(fsMod.mkdirSync).not.toHaveBeenCalled();
	});

	// test-contract: bug — ensureDir must pass {recursive:true} to mkdirSync; without it mkdirSync throws ENOENT with >1 missing path segment, uncaught since logBreakGlass only try/catches appendFileSync.
	it("recursively creates multiple missing parent directories without throwing", () => {
		const base = makeTmpDir();
		const cwd = join(base, "does", "not", "exist-yet");
		expect(existsSync(cwd)).toBe(false);
		expect(() => {
			logBreakGlass(cwd, {
				ts: "2026-01-01T00:00:00Z",
				user: "u",
				session_id: "s",
				tool: "t",
				reason: null,
				commit_sha: null,
			});
		}).not.toThrow();
		expect(existsSync(logPath(cwd))).toBe(true);
		const entries = readBreakGlassLog(cwd);
		expect(entries).toHaveLength(1);
	});
});
