// ===========================================
// interlinked mutation measure — render + record helpers
// ===========================================
// Extracted from mutation.ts (large-file-policy.ts's per-file line cap) — the
// `mutation measure` CLI command's own render/record helpers, with no
// behavior change. `mutationMeasureCommand` (mutation.ts) imports these.

import { execFile } from "node:child_process";
import type { SuiteRunner } from "../harness/mutation/baseline-suite.js";
import type { MeasureOutcome, SurvivorEntry } from "../harness/mutation/measure.js";
import type { MutationTestScopeResult } from "../harness/mutation/test-scope.js";
import { c, header, kvLine } from "../lib/formatter.js";

/** Ceiling on the pre-flight suite run. The probe exists to SAVE time; one that
 *  can outlast the mutation run it guards would defeat its own purpose, so it
 *  gives up and reports `skipped` rather than becoming the slow step. */
const PREFLIGHT_TIMEOUT_MS = 180_000;

/**
 * The real `SuiteRunner` — spawn vitest over exactly the scoped test files.
 *
 * `execFile` (not `exec`): the test paths come from the import graph and go to
 * the process argv as a list, never through a shell, so a path containing shell
 * metacharacters cannot become a command. A nonzero exit is a RESULT here, not
 * an error — the callback's `err` is deliberately folded into the exit code
 * rather than rejected, since "the suite failed" is precisely what the probe
 * asked about.
 */
export const spawnVitestSuite: SuiteRunner = ({ tests, cwd }) =>
	new Promise((resolvePromise, rejectPromise) => {
		// No `--reporter=...` override: the repo's configured reporter is the one
		// known to work here. Pinning a reporter name couples this probe to a
		// vitest major — `basic` was removed in v4, and passing it made vitest
		// exit nonzero before running anything, which the probe then read as a
		// red suite (see baseline-suite.ts::sawTestSession).
		const child = execFile(
			"npx",
			["vitest", "run", ...tests],
			{ cwd, timeout: PREFLIGHT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				// A spawn-level failure (npx missing, timeout kill) has no exit code
				// and must NOT be read as a red suite — reject so the probe reports
				// `skipped`, which the caller treats as "unknown", never as "passed".
				const code = (err as { code?: unknown } | null)?.code;
				if (err && typeof code !== "number") {
					rejectPromise(err);
					return;
				}
				resolvePromise({ exitCode: typeof code === "number" ? code : 0, stdout, stderr });
			},
		);
		child.on("error", rejectPromise);
	});

/** One-line progress note for the resolved test scope — empty string when
 *  there is nothing worth saying (a plain filename-glob fallback with no
 *  cap involved; the runner's own log already covers that case). */
export function testScopeNote(scope: MutationTestScopeResult): string {
	if (scope.tests) return `test scope: ${scope.tests.length} test(s) via the import graph\n`;
	if (scope.reason === "over_cap") {
		return `test scope: graph selected ${scope.uncappedCount} test(s), over cap — falling back to filename-glob scope\n`;
	}
	return "";
}

/**
 * Public API — run the green-suite pre-flight and return a FATAL message, or
 * null to proceed.
 *
 * Collapsing the outcome to `string | null` keeps the caller at two branches:
 * `mutationMeasureCommand` is already near the cognitive cap, and the decision
 * it needs to make really is binary. The non-fatal `skipped` note is written
 * here because it belongs with the probe, not with the dispatch.
 */
export async function preflightScopedSuite(args: {
	tests: string[];
	cwd: string;
	quiet: boolean;
}): Promise<string | null> {
	const { probeScopedSuite, redSuiteMessage } = await import("../harness/mutation/baseline-suite.js");
	const probe = await probeScopedSuite({ tests: args.tests, cwd: args.cwd, run: spawnVitestSuite });
	if (probe.status === "red") return redSuiteMessage(probe);
	if (probe.status === "skipped" && !args.quiet) {
		// Skipped is UNKNOWN, not green. Saying nothing here would let a reader
		// infer the suite was checked and passed — the same conflation the probe
		// exists to prevent.
		process.stderr.write(`pre-flight skipped (${probe.skipReason}) — suite health is unverified\n`);
	}
	return null;
}

export interface MeasureRecordSummary {
	recorded: boolean;
	reason?: string;
	before?: { mutants: number; survivors: number };
	after?: { mutants: number; survivors: number };
}

/** Attempt the record step, iff `--record` was passed AND the run actually
 *  measured cleanly. A `not_measurable`/`error`/`busy` outcome carries no
 *  `rawReport` (measure.ts never sets one for those), so this branch cannot
 *  reach the write path with anything but a real, complete report. */
export async function maybeRecordMeasurement(args: {
	record: boolean | undefined;
	outcome: MeasureOutcome;
	configDir: string;
	key: string;
	content: string;
	cwd: string;
}): Promise<MeasureRecordSummary | null> {
	if (!args.record) return null;
	if (args.outcome.status !== "measured") {
		return {
			recorded: false,
			reason: `run was ${args.outcome.status}${args.outcome.reason ? ` (${args.outcome.reason})` : ""} — nothing to record`,
		};
	}
	const { emptyManifest, loadManifest, saveManifest } = await import("../harness/mutation/manifest.js");
	const { recordMeasurement } = await import("../harness/mutation/measure.js");
	const base =
		loadManifest(args.configDir) ??
		emptyManifest({
			engine: "stryker",
			engineVersion: "unknown",
			dependencyGraphVersion: "1",
			environmentHash: "cli-measure",
			authoritativeAt: new Date().toISOString(),
		});
	const rec = recordMeasurement({
		base,
		file: args.key,
		content: args.content,
		rawReport: args.outcome.rawReport,
		at: new Date().toISOString(),
		cwd: args.cwd,
	});
	// The write — and ONLY the write. `saveManifest` is the library's own fs
	// persister (manifest.ts); this command never touches mutation-manifest.json
	// through any other path.
	if (rec.recorded && rec.manifest) saveManifest(args.configDir, rec.manifest);
	return {
		recorded: rec.recorded,
		...(rec.reason !== undefined ? { reason: rec.reason } : {}),
		...(rec.before !== undefined ? { before: rec.before } : {}),
		...(rec.after !== undefined ? { after: rec.after } : {}),
	};
}

function renderSurvivorLines(survivors: SurvivorEntry[]): string[] {
	return survivors.map((s) => `    L${s.line}  ${s.mutator} -> ${JSON.stringify(s.replacement).slice(0, 90)}`);
}

function renderMeasureOutcome(outcome: MeasureOutcome): string[] {
	if (outcome.status === "not_measurable") {
		return [c.yellow(`  NOT MEASURABLE: ${outcome.reason ?? "unknown reason"}`)];
	}
	if (outcome.status === "busy") {
		// Deliberately NOT rendered as NOT MEASURABLE: a busy runner never
		// answered, so this is not a no_tests verdict — conflating the two is
		// the exact measurement-integrity defect that drops a contended file
		// out of the campaign's denominator.
		return [c.yellow(`  RUNNER BUSY: ${outcome.reason ?? "all endpoints busy"} — not measured, retry later`)];
	}
	if (outcome.status === "error") {
		return [c.red(`  FAILED: ${outcome.reason ?? "unknown error"}`)];
	}
	return [
		kvLine("Mutants", String(outcome.mutantCount)),
		kvLine("Survivors", String(outcome.survivorCount)),
		...renderSurvivorLines(outcome.survivors),
	];
}

function renderRecordSummary(record: MeasureRecordSummary | null): string[] {
	if (!record) return [];
	if (!record.recorded) return ["", c.yellow(`  Not recorded: ${record.reason ?? "unknown reason"}`)];
	const before = record.before ? `${record.before.survivors}/${record.before.mutants}` : "?";
	const after = record.after ? `${record.after.survivors}/${record.after.mutants}` : "?";
	return ["", c.green(`  ✓ Recorded: ${before} → ${after} survivors/mutants (survivors/mutants, before → after)`)];
}

export function renderMeasureCommand(
	file: string,
	outcome: MeasureOutcome,
	record: MeasureRecordSummary | null,
): string {
	return [header(`Mutation Measure — ${file}`), ...renderMeasureOutcome(outcome), ...renderRecordSummary(record)].join(
		"\n",
	);
}
