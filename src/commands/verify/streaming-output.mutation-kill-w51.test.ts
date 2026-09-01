import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getActiveSkipChecks,
	runToolSilent,
	runToolWithSpinner,
	setActiveSkipChecks,
	streamCqSection,
} from "./streaming-output.js";
import type { CodeQualityIssue } from "./tool-results-types.js";

function issue(file: string, message: string, line = 1): CodeQualityIssue {
	return { check: "test_check", file, line, message };
}

function stripAnsi(s: string): string {
	// Strip ANSI codes before comparing rendered output.
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("streamCqSection", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	const savedSkip = getActiveSkipChecks();

	beforeEach(() => {
		writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		setActiveSkipChecks(new Set());
	});

	afterEach(() => {
		writeSpy.mockRestore();
		setActiveSkipChecks(savedSkip);
	});

	function calls(): string[] {
		return writeSpy.mock.calls.map((c: unknown[]) => String(c[0]));
	}

	// test-contract: public-api — kills c668f89d9aab42e4 (ConditionalExpression
	// -> true): with the skip set empty, the section must NOT be skipped — it
	// must render its pass-label text, not silently return.
	it("does not skip when the active skip-check set is empty", () => {
		streamCqSection({
			label: "My Section",
			issues: [],
			noun: "issues",
			passLabel: "all clear",
			details: false,
			color: "32",
			allFlaggedFiles: new Set(),
		});
		const joined = stripAnsi(calls().join(""));
		expect(joined).toContain("all clear");
	});

	// test-contract: public-api — kills c668f89d9aab42e4 further: an active,
	// non-matching skip set must still allow the section to render its
	// pass-label text (proves the condition is not just hardcoded true).
	it("renders when the skip set is non-empty but does not contain this key", () => {
		setActiveSkipChecks(new Set(["some_other_check"]));
		streamCqSection({
			label: "Another Section",
			skipId: "this_check",
			issues: [],
			noun: "issues",
			passLabel: "all clear",
			details: false,
			color: "32",
			allFlaggedFiles: new Set(),
		});
		const joined = stripAnsi(calls().join(""));
		expect(joined).toContain("all clear");
	});

	// kills 7627d2ad593f3842 (StringLiteral header -> ``): exact header text
	// must be present including the ANSI bold wrapper and label.
	// test-contract: public-api — streamCqSection's stderr output contract
	// includes a bold header line naming the section.
	it("writes the exact bold header line for the pass branch", () => {
		streamCqSection({
			label: "Header Label",
			issues: [],
			noun: "issues",
			passLabel: "all good",
			details: false,
			color: "32",
			allFlaggedFiles: new Set(),
		});
		const joined = calls().join("");
		expect(joined).toContain("\n  \x1b[1mHeader Label\x1b[0m\n");
		expect(joined.length).toBeGreaterThan(0);
	});

	// kills 38fb1dbbe20715d7 (MethodExpression .sort() removed): file list
	// must appear in alphabetical order, not Set-insertion order.
	// test-contract: invariant — the flagged-file listing is documented as
	// sorted output, not raw insertion order.
	it("lists flagged files in sorted order", () => {
		streamCqSection({
			label: "Sort Section",
			issues: [issue("zeta.ts", "z issue"), issue("alpha.ts", "a issue")],
			noun: "issues",
			passLabel: "n/a",
			details: false,
			color: "31",
			allFlaggedFiles: new Set(),
		});
		const joined = stripAnsi(calls().join(""));
		const alphaIdx = joined.indexOf("alpha.ts");
		const zetaIdx = joined.indexOf("zeta.ts");
		expect(alphaIdx).toBeGreaterThanOrEqual(0);
		expect(zetaIdx).toBeGreaterThanOrEqual(0);
		expect(alphaIdx).toBeLessThan(zetaIdx);
	});

	// kills f35544437042bbc9 (r.file === file -> true) and dff8aef5df2fed1c
	// (issues.filter(...) -> issues): per-file detail lines must only show
	// issues belonging to that specific file, not every issue in the run.
	// test-contract: invariant — details are grouped strictly per file; a
	// cross-file leak in the detail listing is a correctness bug.
	it("shows only the matching file's issues under its detail section", () => {
		streamCqSection({
			label: "Detail Section",
			issues: [issue("a.ts", "MESSAGE_FROM_A"), issue("b.ts", "MESSAGE_FROM_B")],
			noun: "issues",
			passLabel: "n/a",
			details: true,
			color: "31",
			allFlaggedFiles: new Set(),
		});
		const rawCalls = calls();
		// Find the write call for the a.ts file-name line and confirm the
		// detail line that immediately follows carries only A's message.
		const fileLineIdx = rawCalls.findIndex((c) => stripAnsi(c).includes("a.ts"));
		expect(fileLineIdx).toBeGreaterThanOrEqual(0);
		const detailLine = stripAnsi(rawCalls[fileLineIdx + 1] ?? "");
		expect(detailLine).toContain("MESSAGE_FROM_A");
		expect(detailLine).not.toContain("MESSAGE_FROM_B");
	});

	// kills 2d969567e8b9dd2c (issueFiles.size > MAX_LISTED_FILES -> >=):
	// exactly 15 files (the MAX_LISTED_FILES boundary) must NOT print the
	// "...and N more files" trailer.
	// test-contract: boundary — MAX_LISTED_FILES=15 is the display cap; the
	// overflow trailer must trigger strictly past it, not at it.
	it("does not print an overflow trailer at exactly the file-count boundary", () => {
		const issues: CodeQualityIssue[] = [];
		for (let i = 0; i < 15; i++) {
			issues.push(issue(`file${String(i).padStart(2, "0")}.ts`, "msg"));
		}
		streamCqSection({
			label: "Boundary Section",
			issues,
			noun: "issues",
			passLabel: "n/a",
			details: false,
			color: "31",
			allFlaggedFiles: new Set(),
		});
		const joined = stripAnsi(calls().join(""));
		expect(joined).not.toContain("more files");
	});

	// kills 2d969567e8b9dd2c from the other direction: 16 files (one past
	// the boundary) MUST print the overflow trailer with the correct count.
	// test-contract: boundary — one file past MAX_LISTED_FILES must show
	// the exact remainder count in the overflow trailer.
	it("prints the overflow trailer with the correct remainder past the boundary", () => {
		const issues: CodeQualityIssue[] = [];
		for (let i = 0; i < 16; i++) {
			issues.push(issue(`file${String(i).padStart(2, "0")}.ts`, "msg"));
		}
		streamCqSection({
			label: "Overflow Section",
			issues,
			noun: "issues",
			passLabel: "n/a",
			details: false,
			color: "31",
			allFlaggedFiles: new Set(),
		});
		const joined = stripAnsi(calls().join(""));
		expect(joined).toContain("... and 1 more files");
	});
});

describe("runToolWithSpinner — elapsedMs formatting and process wiring", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	// kills 0caf87827295643e / 67d34ced462f8454 (Date.now() - start -> +),
	// a35d2d7d222d4080 (.../1000 -> *1000), and 2815b6a5ed373f64
	// (StringLiteral template -> ``): the early-return path (cmd[0]
	// undefined) must produce a small, well-formatted elapsed time.
	// test-contract: public-api — runToolWithSpinner's elapsedMs field is a
	// human-facing seconds-formatted duration string.
	it("formats a small elapsedMs on the empty-command early-return path", async () => {
		const result = await runToolWithSpinner({
			label: "empty",
			cmd: [],
			cwd: process.cwd(),
			timeoutMs: 1000,
			parseOutput: () => [],
		});
		expect(result.items).toEqual([]);
		expect(result.elapsedMs).toMatch(/^\d+\.\d+s$/);
		const secs = Number.parseFloat(result.elapsedMs);
		expect(secs).toBeGreaterThanOrEqual(0);
		expect(secs).toBeLessThan(5);
	});

	// kills a11f65f9c43ef75a / 09c4a3f6403f92bf (Date.now() - start -> + /
	// /1000 -> *1000 on the close-handler path), and proves the "data"
	// listeners on stdout/stderr actually wire up (else output would be
	// empty).
	// test-contract: public-api — parseOutput receives the concatenation of
	// everything the spawned process wrote to stdout and stderr.
	it("captures combined stdout+stderr output and a small elapsedMs on a real quick process", async () => {
		const result = await runToolWithSpinner<string>({
			label: "quick",
			cmd: ["node", "-e", "process.stdout.write('OUT');process.stderr.write('ERR');"],
			cwd: process.cwd(),
			timeoutMs: 5000,
			parseOutput: (output) => [output],
		});
		expect(result.items).toEqual(["OUTERR"]);
		expect(result.elapsedMs).toMatch(/^\d+\.\d+s$/);
		expect(Number.parseFloat(result.elapsedMs)).toBeLessThan(5);
	});

	// kills 90528ffd5efd1053 (Date.now() - start -> + inside the spinner
	// interval callback): while the process is still running, the spinner
	// frame must display a small, plausible elapsed-seconds count, not a
	// huge number produced by adding two epoch timestamps.
	// test-contract: public-api — the animated spinner frame written to
	// stderr shows the elapsed seconds since the run began.
	it("renders a small elapsed-seconds count in the live spinner frame", async () => {
		await runToolWithSpinner({
			label: "spin",
			cmd: ["node", "-e", "setTimeout(() => process.exit(0), 250);"],
			cwd: process.cwd(),
			timeoutMs: 5000,
			parseOutput: () => [],
		});
		const spinnerCalls = writeSpy.mock.calls
			.map((c: unknown[]) => String(c[0]))
			.filter((s: string) => s.includes("\x1b[36m") && s.includes("spin"));
		expect(spinnerCalls.length).toBeGreaterThan(0);
		for (const s of spinnerCalls) {
			const match = stripAnsi(s).match(/(\d+)s$/);
			expect(match).not.toBeNull();
			if (match) {
				expect(Number.parseInt(match[1] ?? "999999", 10)).toBeLessThan(10);
			}
		}
	});
});

describe("runToolSilent — elapsedMs formatting and process wiring", () => {
	// kills d34b691f9bab6302 (StringLiteral -> ``), fd138b647b3aadaa
	// (.../1000 -> *1000), da17823b609fbc7b (Date.now() - start -> +) on
	// the empty-command early-return path.
	// test-contract: public-api — runToolSilent's elapsedMs field is a
	// human-facing seconds-formatted duration string.
	it("runToolSilent formats a small elapsedMs on the empty-command early-return path", async () => {
		const result = await runToolSilent({
			cmd: [],
			cwd: process.cwd(),
			timeoutMs: 1000,
			parseOutput: () => [],
		});
		expect(result.items).toEqual([]);
		expect(result.elapsedMs).toMatch(/^\d+\.\d+s$/);
		const secs = Number.parseFloat(result.elapsedMs);
		expect(secs).toBeGreaterThanOrEqual(0);
		expect(secs).toBeLessThan(5);
	});

	// kills 6a8ef605b4575c19 / 7114fbd7c6788898 ("data" -> ""), and
	// 42896597a93cbb3b / 94fd3f3bcdd55d6d (Date.now() arithmetic mutants on
	// the close-handler path): stdout+stderr must be captured, and elapsed
	// must stay small.
	// test-contract: public-api — parseOutput receives the concatenation of
	// everything the spawned process wrote to stdout and stderr.
	it("runToolSilent captures combined stdout+stderr output and a small elapsedMs on a real quick process", async () => {
		const result = await runToolSilent<string>({
			cmd: ["node", "-e", "process.stdout.write('A');process.stderr.write('B');"],
			cwd: process.cwd(),
			timeoutMs: 5000,
			parseOutput: (output) => [output],
		});
		expect(result.items).toEqual(["AB"]);
		expect(result.elapsedMs).toMatch(/^\d+\.\d+s$/);
		expect(Number.parseFloat(result.elapsedMs)).toBeLessThan(5);
	});

	// kills 607d7fe3562126d1 (Date.now() - start -> + on the error-handler
	// path): a spawn failure (nonexistent binary) must still resolve with a
	// small elapsedMs, not a huge one from summing two epoch timestamps.
	// test-contract: bug — a spawn 'error' event (ENOENT) must still resolve
	// with a sane, small elapsed-time value, not a garbage large one.
	it("formats a small elapsedMs when the spawned binary does not exist", async () => {
		const result = await runToolSilent({
			cmd: ["/definitely-not-a-real-binary-w51-mutation-kill"],
			cwd: process.cwd(),
			timeoutMs: 2000,
			parseOutput: () => [],
		});
		expect(result.items).toEqual([]);
		expect(result.elapsedMs).toMatch(/^\d+\.\d+s$/);
		const secs = Number.parseFloat(result.elapsedMs);
		expect(secs).toBeGreaterThanOrEqual(0);
		expect(secs).toBeLessThan(5);
	});
});
