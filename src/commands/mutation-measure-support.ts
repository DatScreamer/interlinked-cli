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
import type { MeasurementScope, MeasurementSurface } from "../harness/mutation/types.js";
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

export interface MaybeRecordProvenance {
	scope: MeasurementScope;
	testCount: number;
	surface: MeasurementSurface;
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
	provenance?: MaybeRecordProvenance | undefined;
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
		...(args.provenance !== undefined ? { provenance: args.provenance } : {}),
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

// ===========================================
// measureOneFile — the single-file pipeline, shared by `measure` and `sweep`
// ===========================================
// Extracted 2026-08-09 when `mutation sweep` arrived: the resolve → test-scope →
// overlay-closure → RED-suite pre-flight → measure → record sequence encodes
// several policies that must NOT exist twice (most sharply the pre-flight, whose
// absence silently forges ~155 killed mutants against a red suite). One step,
// two drivers.

/** Injected in tests; the default is the real network-backed `measureFile`. */
export type MeasureFn = (args: {
	file: string;
	content: string;
	overlays: Array<{ path: string; content: string }>;
	endpoints: string[];
	token?: string | undefined;
	deadlineMs?: number | undefined;
	testScope?: string[] | undefined;
}) => Promise<MeasureOutcome>;

/** Returns a fatal message, or null to proceed. Injected in tests. */
export type PreflightFn = (args: { tests: string[]; cwd: string; quiet: boolean }) => Promise<string | null>;

export interface MeasureOneArgs {
	/** Any spelling of the path; normalized to the manifest's canonical key. */
	file: string;
	cwd: string;
	configDir: string;
	record?: boolean | undefined;
	skipPreflight?: boolean | undefined;
	budgetMs?: number | undefined;
	runnerUrl?: string | undefined;
	/** Ordered fallback list — index 0 is tried first. Preferred over
	 *  `runnerUrl` when both are given. A caller that can reach several runners
	 *  passes all of them so a disconnected host costs one retry round, not the
	 *  whole per-file budget. */
	runnerUrls?: string[] | undefined;
	/** Suppress the progress notes this step writes to stderr. */
	quiet?: boolean | undefined;
	/** Progress sink, called as each note is produced (before the run starts). */
	onNote?: ((note: string) => void) | undefined;
	/** Recorded with the measurement so a later reader knows which surface (and
	 *  therefore which budget and scope) produced it. */
	surface?: MeasurementSurface | undefined;
	measure?: MeasureFn | undefined;
	preflight?: PreflightFn | undefined;
}

/**
 * Every way one file's measurement can end.
 *
 * `unreadable`, `no_runner` and `red_suite` are the caller's own refusals and
 * stay DISTINCT from the runner's four outcomes — a sweep that reported them as
 * `error` would blame the runner for a local misconfiguration, and a sweep that
 * reported them as `not_measurable` would claim the file has no tests.
 */
export interface MeasureOneResult {
	file: string;
	status: MeasureOutcome["status"] | "unreadable" | "no_runner" | "red_suite";
	reason?: string;
	mutants: number;
	survivors: number;
	survivorList: SurvivorEntry[];
	record: MeasureRecordSummary | null;
	/** Human-readable notes (scope size, dropped overlays) for a verbose caller. */
	notes: string[];
}

function refusal(file: string, status: MeasureOneResult["status"], reason: string): MeasureOneResult {
	return { file, status, reason, mutants: 0, survivors: 0, survivorList: [], record: null, notes: [] };
}

/** Resolve the runner endpoints for this run: an explicit override wins, else
 *  the repo's configured `per_edit_mutation` endpoints. */
async function resolveEndpoints(
	args: MeasureOneArgs,
	readDisk: (p: string) => string | null,
): Promise<{ endpoints: string[]; token?: string | undefined }> {
	if (args.runnerUrls && args.runnerUrls.length > 0) return { endpoints: [...args.runnerUrls] };
	if (args.runnerUrl) return { endpoints: [args.runnerUrl] };
	const { configuredRunnerEndpoints } = await import("../harness/mutation/measure.js");
	return configuredRunnerEndpoints(args.cwd, readDisk);
}

export async function measureOneFile(args: MeasureOneArgs): Promise<MeasureOneResult> {
	const { buildScopedMeasureOverlays, measureFile, readDiskSafe } = await import("../harness/mutation/measure.js");
	const { normalizeManifestKey } = await import("../harness/mutation/manifest.js");
	const { computeMutationTestScopeForRepo } = await import("../harness/mutation/test-scope.js");
	const { resolve } = await import("node:path");

	const key = normalizeManifestKey(args.file, args.cwd);
	const content = readDiskSafe(resolve(args.cwd, key));
	if (content === null) return refusal(key, "unreadable", `Cannot read "${key}" (resolved from "${args.file}").`);

	const endpointCfg = await resolveEndpoints(args, readDiskSafe);
	if (endpointCfg.endpoints.length === 0) {
		return refusal(
			key,
			"no_runner",
			"No mutation runner configured. Pass --runner-url, or set per_edit_mutation.runner_url (or .runner_urls) in .interlinked/guard-rules.local.json.",
		);
	}

	// Reverse-import-graph test selection, not the runner's filename-glob guess:
	// a hub file's real tests are often not named after it. Computed BEFORE the
	// overlay set so the overlays can close over every test the runner loads.
	const scope = computeMutationTestScopeForRepo({ editedRelPath: key, projectRoot: args.cwd });
	const scopeTests = scope.tests ?? [];
	const scoped = buildScopedMeasureOverlays(key, content, (p) => readDiskSafe(resolve(args.cwd, p)), scopeTests);
	const notes = overlayNotes({ key, scope, scoped, runnerCount: endpointCfg.endpoints.length });
	// Emitted BEFORE the run, not returned after it: these lines exist to tell an
	// operator what a multi-minute run is about to do, and a note delivered on
	// completion answers a question nobody still has.
	for (const note of notes) args.onNote?.(note);

	if (args.skipPreflight !== true) {
		const run = args.preflight ?? preflightScopedSuite;
		const red = await run({ tests: scopeTests, cwd: args.cwd, quiet: args.quiet === true });
		if (red !== null) return { ...refusal(key, "red_suite", red), notes };
	}

	// The default carries the real `fetch`; an injected `measure` is the test seam
	// and must never be handed a live network implementation it did not ask for.
	// Optional keys are re-spread rather than forwarded, because the repo runs
	// `exactOptionalPropertyTypes` — an explicit `token: undefined` is a type
	// error, not a synonym for "absent".
	const measure: MeasureFn =
		args.measure ??
		((a) =>
			measureFile({
				file: a.file,
				content: a.content,
				overlays: a.overlays,
				endpoints: a.endpoints,
				fetchImpl: (url, init) => fetch(url, init),
				...(a.token !== undefined ? { token: a.token } : {}),
				...(a.deadlineMs !== undefined ? { deadlineMs: a.deadlineMs } : {}),
				...(a.testScope !== undefined ? { testScope: a.testScope } : {}),
			}));
	const outcome = await measure({
		file: key,
		content,
		overlays: scoped.overlays,
		endpoints: endpointCfg.endpoints,
		...(endpointCfg.token !== undefined ? { token: endpointCfg.token } : {}),
		...(args.budgetMs !== undefined && Number.isFinite(args.budgetMs) ? { deadlineMs: args.budgetMs } : {}),
		...(scope.tests ? { testScope: scope.tests } : {}),
	});

	const record = await maybeRecordMeasurement({
		record: args.record,
		outcome,
		configDir: args.configDir,
		key,
		content,
		cwd: args.cwd,
		// Stamp HOW this ran. Two survivor counts for the same file are only
		// comparable when they were measured the same way, and this pipeline's
		// import-graph scope kills far more mutants than the runner's own
		// filename-glob guess — 186 survivors vs 18 on one unedited file.
		provenance: {
			scope: scope.tests ? "import_graph" : "glob_fallback",
			testCount: scopeTests.length,
			surface: args.surface ?? "measure",
		},
	});

	return {
		file: key,
		status: outcome.status,
		...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
		mutants: outcome.mutantCount,
		survivors: outcome.survivorCount,
		survivorList: outcome.survivors,
		record,
		notes,
	};
}

/** What this run is about to do, and what the overlay closure had to leave out.
 *  Silence on a partial closure would let an incomplete overlay set read as a
 *  complete one, so every omission is named — with the file names, since
 *  "dropped 2 files" cannot be acted on and "dropped a.ts, b.ts" can. */
function overlayNotes(args: {
	key: string;
	scope: MutationTestScopeResult;
	scoped: {
		overlays: unknown[];
		unreadable: string[];
		capped?: { candidateCount: number; limit: number; dropped: string[] } | undefined;
	};
	runnerCount: number;
}): string[] {
	const { key, scope, scoped, runnerCount } = args;
	const notes: string[] = [
		`measuring ${key} (${scoped.overlays.length} overlay(s)) via ${runnerCount} runner(s)…${testScopeNote(scope) ? `\n${testScopeNote(scope).trimEnd()}` : ""}`,
	];
	if (scoped.unreadable.length > 0) {
		notes.push(
			`WARNING: ${scoped.unreadable.length} file(s) in the closure could not be read and are MISSING from the overlay set: ${scoped.unreadable.join(", ")}`,
		);
	}
	if (scoped.capped) {
		notes.push(
			`WARNING: overlay closure had ${scoped.capped.candidateCount} candidates, capped to ${scoped.capped.limit}; dropped ${scoped.capped.dropped.length} dependency file(s): ${scoped.capped.dropped.join(", ")}`,
		);
	}
	return notes;
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
