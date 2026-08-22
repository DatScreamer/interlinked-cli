import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { registerIndexCommand } from "./index-cmd.js";

// ===========================================
// Mutation-kill suite for `interlinked index` (wave 36)
// ===========================================
// Targets 34 survived mutants from the manifest: description/option-help
// string literals, elapsed-time arithmetic (build + update), the "\r"
// clear-line write, baseCommit slicing (build + status), status template
// lines, the avgNextMaskBits optional-chain, the freshness index-path
// segments, ageMinutes/onProgress/candidates-length boundary comparisons,
// and formatBytes's two boundary comparisons. Companion behavioral coverage
// lives in index-cmd.test.ts; this file adds the exact-value / boundary
// assertions needed to distinguish original from mutant.

const h = vi.hoisted(() => {
	return {
		build: vi.fn(),
		load: vi.fn(),
		loadMeta: vi.fn(),
		save: vi.fn(),
		stats: vi.fn(),
		incrementalUpdate: vi.fn(),
		queryCandidatePaths: vi.fn(),
		decomposePattern: vi.fn(),
		existsSync: vi.fn(),
		statSync: vi.fn(),
	};
});

vi.mock("../harness/trigram-index.js", () => ({
	TrigramIndex: {
		build: h.build,
		load: h.load,
		loadMeta: h.loadMeta,
	},
}));

vi.mock("../harness/regex-trigrams.js", () => ({
	decomposePattern: h.decomposePattern,
}));

vi.mock("node:fs", () => ({
	existsSync: h.existsSync,
	statSync: h.statSync,
}));

interface Captured {
	stdout: string;
	writes: unknown[];
	exitCode: string | number | undefined;
}

function captureIO(): { get: () => Captured; restore: () => void } {
	let stdout = "";
	const writes: unknown[] = [];
	const origExit = process.exitCode;
	process.exitCode = undefined;
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		stdout += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
	});
	const writeSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			writes.push(chunk);
			stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
	return {
		get: () => ({ stdout, writes, exitCode: process.exitCode }),
		restore: () => {
			logSpy.mockRestore();
			writeSpy.mockRestore();
			process.exitCode = origExit;
		},
	};
}

function newProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerIndexCommand(program);
	return program;
}

async function runIndex(...args: string[]): Promise<void> {
	await newProgram().parseAsync(["index", ...args], { from: "user" });
}

function fakeIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		baseCommit: "abcdef1234567890",
		totalFiles: 100,
		save: h.save,
		stats: h.stats,
		incrementalUpdate: h.incrementalUpdate,
		queryCandidatePaths: h.queryCandidatePaths,
		...overrides,
	};
}

const fullStats = {
	fileCount: 1234,
	trigramCount: 56789,
	stopTrigramCount: 42,
	baseCommit: "deadbeefcafef00d",
	indexSizeBytes: 2_500_000,
	builtAt: "2026-06-06T00:00:00.000Z",
};

let io: ReturnType<typeof captureIO>;

beforeEach(() => {
	vi.clearAllMocks();
	io = captureIO();
});

afterEach(() => {
	io.restore();
	vi.restoreAllMocks();
});

// ===========================================
// Description / option-help string literals (13 mutants)
// ===========================================
describe("index command help text (description strings)", () => {
	// test-contract: public-api — every description/help string is user-facing CLI help text
	it("carries every literal description/help string for all subcommands and options", () => {
		const program = newProgram();
		const indexCmd = nonNull(program.commands.find((c) => c.name() === "index"));
		expect(indexCmd.description()).toBe("Manage the trigram search index for grep acceleration");

		const build = nonNull(indexCmd.commands.find((c) => c.name() === "build"));
		expect(build.description()).toBe("Build a full trigram index from the current codebase");
		const buildCwd = nonNull(build.options.find((o) => o.long === "--cwd"));
		expect(buildCwd.description).toBe("Working directory");
		const maxFileSize = nonNull(build.options.find((o) => o.long === "--max-file-size"));
		expect(maxFileSize.description).toBe("Skip files larger than this");
		const stopThreshold = nonNull(build.options.find((o) => o.long === "--stop-threshold"));
		expect(stopThreshold.description).toBe("Stop trigram threshold (0-1)");

		const update = nonNull(indexCmd.commands.find((c) => c.name() === "update"));
		expect(update.description()).toBe("Incrementally update the index from git changes");
		const updateCwd = nonNull(update.options.find((o) => o.long === "--cwd"));
		expect(updateCwd.description).toBe("Working directory");

		const status = nonNull(indexCmd.commands.find((c) => c.name() === "status"));
		expect(status.description()).toBe("Show index status and statistics");
		const statusCwd = nonNull(status.options.find((o) => o.long === "--cwd"));
		expect(statusCwd.description).toBe("Working directory");
		const jsonOpt = nonNull(status.options.find((o) => o.long === "--json"));
		expect(jsonOpt.description).toBe("Output as JSON");

		const query = nonNull(indexCmd.commands.find((c) => c.name() === "query"));
		expect(query.description()).toBe("Query the index for candidate files (debug tool)");
		const queryCwd = nonNull(query.options.find((o) => o.long === "--cwd"));
		expect(queryCwd.description).toBe("Working directory");
		const regexOpt = nonNull(query.options.find((o) => o.long === "--regex"));
		expect(regexOpt.description).toBe("Treat pattern as regex");
	});
});

// ===========================================
// build: elapsed-time arithmetic + "\r" clear + baseCommit slice
// ===========================================
describe("index build — elapsed arithmetic, clear-line write, baseCommit slice", () => {
	// test-contract: invariant — (4500-1000)/1000 = 3.5s; *1000 or +startTime would diverge sharply
	it("computes elapsed as (end - start) / 1000 with exact values", async () => {
		h.stats.mockReturnValue(fullStats);
		h.build.mockReturnValue(fakeIndex());
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(1000); // startTime capture
		nowSpy.mockReturnValue(4500); // Date.now() at elapsed calc (and beyond)

		await runIndex("build", "--cwd", "/repo");

		expect(io.get().stdout).toContain("Index built in 3.5s");
	});

	// test-contract: invariant — an empty-string mutant of the clear write drops this call
	it("writes a literal bare \\r to clear the progress line", async () => {
		h.stats.mockReturnValue(fullStats);
		h.build.mockReturnValue(fakeIndex());

		await runIndex("build", "--cwd", "/repo");

		expect(io.get().writes).toContainEqual("\r");
	});

	// test-contract: invariant — dropping .slice(0,8) would print the full 16-char hash
	it("slices baseCommit to exactly 8 characters (not the full hash)", async () => {
		h.stats.mockReturnValue({ ...fullStats, baseCommit: "abcdefgh12345678" });
		h.build.mockReturnValue(fakeIndex());

		await runIndex("build", "--cwd", "/repo");

		const { stdout } = io.get();
		expect(stdout).toContain("Base commit: abcdefgh\n");
		expect(stdout).not.toContain("abcdefgh12345678");
	});
});

// ===========================================
// update: elapsed-time arithmetic
// ===========================================
describe("index update — elapsed arithmetic", () => {
	// test-contract: invariant — (4500-1000)/1000 = 3.5s; *1000 or +startTime would diverge sharply
	it("computes elapsed as (end - start) / 1000 with exact values", async () => {
		h.incrementalUpdate.mockReturnValue(7);
		h.load.mockReturnValue(fakeIndex());
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(1000); // startTime capture
		nowSpy.mockReturnValue(4500); // elapsed calc

		await runIndex("update", "--cwd", "/repo");

		expect(io.get().stdout).toContain("Updated 7 files in 3.5s");
	});
});

// ===========================================
// status: template lines + baseCommit slice + optional chaining
// ===========================================
describe("index status — template lines, baseCommit slice, optional chain", () => {
	// test-contract: invariant — each of these four lines has its own template-string mutant
	it("prints trigrams/index-size/stop-grams/base-commit lines with the sliced hash", async () => {
		h.loadMeta.mockReturnValue({ ...fullStats, baseCommit: "1234567890abcdef" });
		h.existsSync.mockReturnValue(false);

		await runIndex("status", "--cwd", "/repo");

		const { stdout } = io.get();
		expect(stdout).toContain("Trigrams:    56,789");
		expect(stdout).toContain("Index size:  2.4 MB");
		expect(stdout).toContain("Stop grams:  42");
		expect(stdout).toContain("Base commit: 12345678\n");
		// dropping .slice(0,8) would print the full 16-char hash
		expect(stdout).not.toContain("1234567890abcdef");
	});

	// test-contract: bug — removing the `?.` would throw calling .toFixed on undefined
	it("prints 'undefined' for avgNextMaskBits when absent instead of throwing (optional chain)", async () => {
		h.loadMeta.mockReturnValue({
			...fullStats,
			avgLocMaskBits: 12.34,
			avgNextMaskBits: undefined,
		});
		h.existsSync.mockReturnValue(false);

		await expect(runIndex("status", "--cwd", "/repo")).resolves.not.toThrow();

		expect(io.get().stdout).toContain("Avg nextMask: undefined bits/entry");
	});

	// test-contract: invariant — dropping any path segment literal changes which file is probed,
	// so a stale/renamed index file would be reported as fresh instead of skipping the freshness block
	it("only emits the Freshness line when the exact expected index path exists on disk", async () => {
		const fixedNow = 1_000_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(fixedNow);
		h.loadMeta.mockReturnValue(fullStats);
		const expectedPath = join("/repo", ".interlinked", "index", "trigram.lookup");
		h.existsSync.mockImplementation((p: string) => p === expectedPath);
		h.statSync.mockReturnValue({ mtimeMs: fixedNow });

		await runIndex("status", "--cwd", "/repo");

		expect(h.existsSync).toHaveBeenCalledWith(expectedPath);
		// observable: existsSync resolved true only for the exact path, so the freshness
		// line is actually rendered — proving the probed path is the real one, not a
		// mutated/truncated segment that would never match and silently skip the block
		expect(io.get().stdout).toContain("Freshness:");
	});

	// test-contract: boundary — ageMinutes < 1 is false at exactly 1; <= 1 would wrongly say "just built"
	it("reports 'Xmin ago' (not 'just built') at exactly the 1-minute boundary", async () => {
		const fixedNow = 1_000_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(fixedNow);
		h.loadMeta.mockReturnValue(fullStats);
		h.existsSync.mockReturnValue(true);
		h.statSync.mockReturnValue({ mtimeMs: fixedNow - 60_000 }); // ageMinutes === 1 exactly

		await runIndex("status", "--cwd", "/repo");

		const { stdout } = io.get();
		expect(stdout).toContain("Freshness:   1min ago");
		expect(stdout).not.toContain("just built");
	});

	// test-contract: boundary — ageMinutes < 60 is false at exactly 60; <= 60 would wrongly say "60min ago"
	it("reports 'Xh ago' (not '60min ago') at exactly the 60-minute boundary", async () => {
		const fixedNow = 1_000_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(fixedNow);
		h.loadMeta.mockReturnValue(fullStats);
		h.existsSync.mockReturnValue(true);
		h.statSync.mockReturnValue({ mtimeMs: fixedNow - 60 * 60_000 }); // ageMinutes === 60 exactly

		await runIndex("status", "--cwd", "/repo");

		const { stdout } = io.get();
		expect(stdout).toContain("Freshness:   1h ago");
		expect(stdout).not.toContain("60min ago");
	});
});

// ===========================================
// build onProgress throttle: exact 500ms boundary
// ===========================================
describe("index build — onProgress 500ms boundary", () => {
	// test-contract: boundary — now - lastReport > 500 is false at exactly 500;
	// >= 500 would wrongly fire the write
	it("does not write when the gap is exactly 500ms (not just >500)", async () => {
		h.stats.mockReturnValue(fullStats);
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(0); // startTime capture
		nowSpy.mockReturnValueOnce(500); // onProgress internal `now` — gap is exactly 500
		nowSpy.mockReturnValue(500); // elapsed calc + anything after

		h.build.mockImplementation((opts: { onProgress?: (i: number, t: number) => void }) => {
			nonNull(opts.onProgress)(1, 10);
			return fakeIndex();
		});

		await runIndex("build", "--cwd", "/repo");

		const { stdout } = io.get();
		// test-contract: boundary — now - lastReport > 500 is false at exactly 500;
		// >= 500 would wrongly fire the write
		expect(stdout).not.toContain("Indexing... 1/10 files");
	});
});

// ===========================================
// query: exact 50-candidate boundary
// ===========================================
describe("index query — 50-candidate truncation boundary", () => {
	// test-contract: boundary — candidates.length > 50 is false at exactly 50;
	// >= 50 would wrongly print "... and 0 more"
	it("does not print a truncation notice at exactly 50 candidates", async () => {
		const exactly50 = Array.from({ length: 50 }, (_, i) => `src/file-${i}.ts`);
		h.load.mockReturnValue(fakeIndex({ totalFiles: 50 }));
		h.decomposePattern.mockReturnValue({ requiredTrigrams: [7], hasLiterals: true });
		h.queryCandidatePaths.mockReturnValue(exactly50);

		await runIndex("query", "common", "--cwd", "/repo");

		const { stdout } = io.get();
		// test-contract: boundary — candidates.length > 50 is false at exactly 50;
		// >= 50 would wrongly print "... and 0 more"
		expect(stdout).toContain("src/file-49.ts");
		expect(stdout).not.toContain("more");
	});
});

// ===========================================
// formatBytes: exact KB/MB boundaries
// ===========================================
describe("index build — formatBytes boundary values", () => {
	// test-contract: boundary — bytes < BYTES_PER_KB is false at exactly 1024;
	// <= would wrongly report "1024 B"
	it("treats exactly BYTES_PER_KB (1024) as the KB branch, not raw bytes", async () => {
		h.stats.mockReturnValue({ ...fullStats, indexSizeBytes: 1024 });
		h.build.mockReturnValue(fakeIndex());

		await runIndex("build", "--cwd", "/repo");

		const { stdout } = io.get();
		// test-contract: boundary — bytes < BYTES_PER_KB is false at exactly 1024;
		// <= would wrongly report "1024 B"
		expect(stdout).toContain("Index size:  1.0 KB");
		expect(stdout).not.toContain("1024 B");
	});

	// test-contract: boundary — bytes < BYTES_PER_MB is false at exactly 1048576;
	// <= would wrongly report "1024.0 KB"
	it("treats exactly BYTES_PER_MB (1048576) as the MB branch, not KB", async () => {
		h.stats.mockReturnValue({ ...fullStats, indexSizeBytes: 1_048_576 });
		h.build.mockReturnValue(fakeIndex());

		await runIndex("build", "--cwd", "/repo");

		const { stdout } = io.get();
		// test-contract: boundary — bytes < BYTES_PER_MB is false at exactly 1048576;
		// <= would wrongly report "1024.0 KB"
		expect(stdout).toContain("Index size:  1.0 MB");
		expect(stdout).not.toContain("1024.0 KB");
	});
});
