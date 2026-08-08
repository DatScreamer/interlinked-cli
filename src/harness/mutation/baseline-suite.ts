// ===========================================
// Mutation pre-flight — is the scoped test suite GREEN on unmutated source?
// ===========================================
//
// A mutation score is only meaningful if the suite passes on UNMUTATED source.
// When a test is already failing, the engine cannot tell "this mutant broke the
// suite" from "the suite was already broken", and every mutant it touches gets
// reported KILLED. The result is a forged clean pass: the most dangerous shape
// a verification tool can produce, because it is indistinguishable from success.
//
// This is not hypothetical. Measured 2026-08-07 on this repo: an agent driving
// survivors down on `agent-safety-async.ts` saw its survivor count fall from 170
// to 15 in one round and nearly believed it. Two of its own new assertions had
// wrong expectations and were failing on unmutated source — masking ~155 mutants
// as false kills. It caught the mistake only by re-checking the suite by hand.
// The honest number after fixing them was 6.
//
// So: probe the scoped suite BEFORE spending a multi-minute engine run. The
// probe is cheap (the scoped suite is seconds; the mutation run is minutes) and
// it converts the worst failure mode into the clearest possible message.
//
// Engine note: Stryker's own dry run also refuses a red suite, so the REMOTE
// path already fails honestly. This probe exists because that failure arrives
// minutes later as an opaque engine error, and because agents that hand-roll an
// apply/run/revert loop (the thing this module's callers exist to make
// unnecessary) have no dry run at all. Cheap, local, and legible beats correct
// but late.

/** How the probe invokes the test runner. Injected so the decision logic is
 *  unit-testable without spawning a real process. */
export type SuiteRunner = (args: {
	tests: string[];
	cwd: string;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type SuiteProbeStatus = "green" | "red" | "skipped";

export interface SuiteProbeResult {
	status: SuiteProbeStatus;
	/** Number of test files the probe was asked to run. */
	testCount: number;
	/** Why the probe did not run, when `status === "skipped"`. Never a guess:
	 *  a skipped probe is reported as skipped, never as green. */
	skipReason?: string;
	/** Failing-test lines lifted from runner output, best-effort and capped.
	 *  Empty is not evidence of green — read `status`. */
	failures: string[];
}

/** Cap on how many failing-test lines travel back to the caller. A red suite
 *  with hundreds of failures needs a fix, not a full transcript. */
export const MAX_REPORTED_FAILURES = 12;

/**
 * Did the runner actually get far enough to report on tests?
 *
 * A nonzero exit alone does NOT mean "tests failed" — it also covers "the
 * runner refused to start": bad config, a removed CLI flag, a missing plugin. A
 * probe that conflates the two raises a false alarm on a perfectly green suite,
 * which is the same defect as a forged pass wearing the opposite sign, and it
 * costs the same thing: trust in the verdict.
 *
 * Measured 2026-08-07, on this module's own first live run: it was invoked with
 * `--reporter=basic`, a reporter vitest 4 removed. vitest exited nonzero before
 * running a single test, and the probe declared a file's suite RED whose real
 * score was a clean 140/140.
 *
 * So require positive evidence that a test session happened. Absent it, the
 * verdict is `skipped` (unknown) — never `red`, and never `green`.
 */
export function sawTestSession(output: string): boolean {
	return /^\s*(Test Files|Tests)\s/m.test(output) || /\bno test files found\b/i.test(output);
}

/**
 * Lift failing-test lines out of a runner's output.
 *
 * Deliberately conservative and format-agnostic: matches vitest/jest's shared
 * `FAIL <path>` and `× <name>` conventions rather than parsing a reporter's
 * structured output, because the probe must keep working when the repo
 * configures a different reporter. A miss here degrades the MESSAGE, never the
 * VERDICT — the verdict comes from the exit code alone.
 */
export function extractFailureLines(output: string): string[] {
	const out: string[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (/^FAIL\s/.test(line) || /^[×✕✗]\s/.test(line)) {
			out.push(line);
			if (out.length >= MAX_REPORTED_FAILURES) break;
		}
	}
	return out;
}

/**
 * Public API — run the scoped suite on unmutated source and report whether it
 * is green.
 *
 * An EMPTY test list is `skipped`, not `green`: "no tests were selected" and
 * "the tests passed" are different facts, and collapsing them would reintroduce
 * the exact confusion this module exists to prevent. The caller decides what a
 * skip means for its own gate.
 *
 * A runner that throws is likewise `skipped` — an unavailable local test runner
 * is a probe failure, not a verdict about the suite. Failing open here is
 * correct: the engine's own dry run remains the backstop.
 */
export async function probeScopedSuite(args: {
	tests: string[];
	cwd: string;
	run: SuiteRunner;
}): Promise<SuiteProbeResult> {
	if (args.tests.length === 0) {
		return {
			status: "skipped",
			testCount: 0,
			skipReason: "no tests selected for this file",
			failures: [],
		};
	}

	let result: Awaited<ReturnType<SuiteRunner>>;
	try {
		result = await args.run({ tests: args.tests, cwd: args.cwd });
	} catch (err) {
		return {
			status: "skipped",
			testCount: args.tests.length,
			skipReason: `test runner could not be started: ${err instanceof Error ? err.message : String(err)}`,
			failures: [],
		};
	}

	const combined = `${result.stdout}\n${result.stderr}`;
	if (result.exitCode === 0) {
		return { status: "green", testCount: args.tests.length, failures: [] };
	}
	// Nonzero, but no evidence a test session ran: the runner itself failed.
	// Report unknown rather than accusing a suite that was never executed.
	if (!sawTestSession(combined)) {
		return {
			status: "skipped",
			testCount: args.tests.length,
			skipReason: `test runner exited ${result.exitCode} without running tests (config or CLI error)`,
			failures: [],
		};
	}
	return {
		status: "red",
		testCount: args.tests.length,
		failures: extractFailureLines(combined),
	};
}

/**
 * Public API — the operator-facing explanation for a red pre-flight.
 *
 * Says what is wrong, why it invalidates the run that was about to happen, and
 * what to do — in that order. The "would be meaningless" clause is load-bearing:
 * without it the message reads as a lint failure the agent may reasonably decide
 * to bypass, rather than as the reason the number it wants cannot be produced.
 */
export function redSuiteMessage(probe: SuiteProbeResult): string {
	const lines = [
		`The scoped test suite is RED on unmutated source (${probe.testCount} test file(s) selected).`,
		"",
		"A mutation run against a failing suite would be meaningless: the engine cannot",
		"distinguish a mutant that broke a test from a test that was already broken, so",
		"every mutant it touches is reported KILLED. The score would look good and mean",
		"nothing.",
		"",
		"Fix the failing tests, then re-run this command.",
	];
	if (probe.failures.length > 0) {
		lines.push("", "Failing:");
		for (const f of probe.failures) lines.push(`  ${f}`);
	}
	return lines.join("\n");
}
