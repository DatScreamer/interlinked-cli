import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessReapCommand } from "./harness-reap.js";
import type { DaemonControlDeps } from "./harness-daemon-control.js";
import type { ReapResult } from "./harness-process.js";

// These tests drive `harnessReapCommand` end-to-end with an injected `reap`
// dependency (via `deps.reap` on `reapOrphanHarnessesVerified`) so the
// candidates/killed data is fully deterministic, and assert on the exact
// text `console.log` receives — which is produced by the unexported
// `formatReapHumanOutput` / `truncate` helpers.

function makeDeps(reapResult: ReapResult): DaemonControlDeps {
	return {
		discover: () => [],
		reap: () => reapResult,
	};
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
});

function lastLog(): string {
	const calls = logSpy.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return String(calls[calls.length - 1]?.[0]);
}

describe("harnessReapCommand — JSON scope field (kills StringLiteral \"all\"/\"orphans\" -> \"\")", () => {
	it("P1: --all sets scope to the literal string \"all\"", async () => {
		await harnessReapCommand({ all: true, json: true }, makeDeps({ candidates: [], killed: [], dryRun: true }));
		const out = lastLog();
		const parsed = JSON.parse(out);
		expect(parsed.scope).toBe("all");
	});

	it("P2: default (no --all) sets scope to the literal string \"orphans\"", async () => {
		await harnessReapCommand({ json: true }, makeDeps({ candidates: [], killed: [], dryRun: true }));
		const out = lastLog();
		const parsed = JSON.parse(out);
		expect(parsed.scope).toBe("orphans");
	});
});

describe("formatReapHumanOutput — empty-candidates branch (via harnessReapCommand)", () => {
	it("N1: prints 'No orphan harness daemons found.' when scope=orphans and no candidates", async () => {
		await harnessReapCommand({}, makeDeps({ candidates: [], killed: [], dryRun: true }));
		const out = lastLog();
		expect(out).toContain("No orphan harness daemons found.");
	});

	it("N2: prints 'No all harness daemons found.' when scope=all and no candidates (kills scopeLabel ternary + \"all harness daemons\" literal)", async () => {
		await harnessReapCommand({ all: true }, makeDeps({ candidates: [], killed: [], dryRun: true }));
		const out = lastLog();
		expect(out).toContain("No all harness daemons found.");
		expect(out).not.toContain("No orphan harness daemons found.");
	});

	it("P3: kills BlockStatement->{} for the empty-candidates branch by asserting the early return happens (no candidate listing text below it)", async () => {
		await harnessReapCommand({}, makeDeps({ candidates: [], killed: [], dryRun: true }));
		const out = lastLog();
		// The block must both push the message AND return immediately — if the
		// block body were emptied, `out` would not contain the "found." message
		// and the join would still run reaching the code below (undefined
		// verb text etc.), which we also guard against.
		expect(out).toContain("No orphan harness daemons found.");
		expect(out).not.toContain("Would reap");
		expect(out).not.toContain("Reaped");
	});
});

describe("formatReapHumanOutput — non-empty candidates, dry-run branch", () => {
	const oneCandidate: ReapResult = {
		candidates: [{ pid: 111, ppid: 1, command: "node dist/harness/server.js" }],
		killed: [],
		dryRun: true,
	};

	it("P4: dry-run header uses 'Would reap' verb and lists a [dry-run] tag, joined by real newlines", async () => {
		await harnessReapCommand({}, makeDeps(oneCandidate));
		const out = lastLog();
		const lines = out.split("\n");
		// If "\n" were mutated to "", everything would collapse to one line.
		expect(lines.length).toBeGreaterThan(1);
		expect(out).toContain("Would reap");
		expect(out).not.toContain("Reaped 1");
		expect(out).toContain("[dry-run]");
		expect(out).not.toContain("[killed]");
	});

	it("P5: dry-run footer includes the force hint text and a blank line before it", async () => {
		await harnessReapCommand({}, makeDeps(oneCandidate));
		const out = lastLog();
		expect(out).toContain("Pass --force to actually SIGTERM these processes.");
		const lines = out.split("\n");
		// blank line pushed via lines.push("") immediately before the hint
		const hintIdx = lines.findIndex((l) => l.includes("Pass --force"));
		expect(hintIdx).toBeGreaterThan(0);
		expect(lines[hintIdx - 1]).toBe("");
	});
});

describe("formatReapHumanOutput — non-empty candidates, force (killed) branch", () => {
	it("P6: force run uses 'Reaped' verb and [killed] tag when all candidates were killed (no skipped line)", async () => {
		const result: ReapResult = {
			candidates: [{ pid: 222, ppid: 1, command: "node dist/harness/server.js" }],
			killed: [222],
			dryRun: false,
		};
		await harnessReapCommand({ force: true }, makeDeps(result));
		const out = lastLog();
		expect(out).toContain("Reaped");
		expect(out).not.toContain("Would reap");
		expect(out).toContain("[killed]");
		expect(out).not.toContain("[dry-run]");
		expect(out).not.toContain("could not be signalled");
	});

	it("P7: force run reports 'skipped' count = candidates.length - killed.length (kills ArithmeticOperator -> +, and skipped>0 mutants)", async () => {
		const result: ReapResult = {
			candidates: [
				{ pid: 1, ppid: 1, command: "a" },
				{ pid: 2, ppid: 1, command: "b" },
				{ pid: 3, ppid: 1, command: "c" },
			],
			killed: [1],
			dryRun: false,
		};
		await harnessReapCommand({ force: true, all: true }, makeDeps(result));
		const out = lastLog();
		// 3 candidates - 1 killed = 2 skipped, plural "s"
		expect(out).toContain("(2 candidates could not be signalled");
		expect(out).not.toContain("(4 candidates");
	});

	it("P8: singular 'candidate' (no trailing s) when exactly one is skipped", async () => {
		const result: ReapResult = {
			candidates: [
				{ pid: 1, ppid: 1, command: "a" },
				{ pid: 2, ppid: 1, command: "b" },
			],
			killed: [1],
			dryRun: false,
		};
		await harnessReapCommand({ force: true }, makeDeps(result));
		const out = lastLog();
		expect(out).toContain("(1 candidate could not be signalled");
		expect(out).not.toContain("(1 candidates could not be signalled");
	});

	it("N3: force run with zero skipped omits the skipped line entirely (kills skipped>0 -> true)", async () => {
		const result: ReapResult = {
			candidates: [{ pid: 1, ppid: 1, command: "a" }],
			killed: [1],
			dryRun: false,
		};
		await harnessReapCommand({ force: true }, makeDeps(result));
		const out = lastLog();
		expect(out).not.toContain("could not be signalled");
	});

	it("P9: force run with a nonzero skip must still print the line (kills skipped>0 -> false)", async () => {
		const result: ReapResult = {
			candidates: [{ pid: 1, ppid: 1, command: "a" }],
			killed: [],
			dryRun: false,
		};
		await harnessReapCommand({ force: true }, makeDeps(result));
		const out = lastLog();
		expect(out).toContain("could not be signalled");
	});
});

describe("truncate() via long command text (via harnessReapCommand)", () => {
	it("P10: a command exactly 70 chars long is NOT truncated (kills <= -> <, and <= -> >)", async () => {
		const cmd = "x".repeat(70);
		const result: ReapResult = {
			candidates: [{ pid: 1, ppid: 1, command: cmd }],
			killed: [],
			dryRun: true,
		};
		await harnessReapCommand({}, makeDeps(result));
		const out = lastLog();
		expect(out).toContain(cmd);
		expect(out).not.toContain("…");
	});

	it("P11: a command longer than 70 chars IS truncated to 69 chars plus an ellipsis (kills BlockStatement->{}, ConditionalExpression, ArithmeticOperator -1)", async () => {
		const cmd = "y".repeat(90);
		const result: ReapResult = {
			candidates: [{ pid: 1, ppid: 1, command: cmd }],
			killed: [],
			dryRun: true,
		};
		await harnessReapCommand({}, makeDeps(result));
		const out = lastLog();
		expect(out).toContain("…");
		const truncated = `${"y".repeat(69)}…`;
		expect(out).toContain(truncated);
		// The full untruncated command must not appear verbatim.
		expect(out).not.toContain(cmd);
	});
});
