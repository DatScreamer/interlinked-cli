// ===========================================
// Per-edit mutation — out-of-band single-file measurement + optional recording
// ===========================================
// Closes the campaign feedback-loop gap: `scratch/measure-file.mts` POSTs to the
// runner and prints results, but never writes them anywhere — so hardening work
// re-measured out of band stays invisible to the manifest the per-edit gate
// enforces against. This module is the first-class, testable replacement the
// `interlinked mutation measure` CLI command composes: request → summarize →
// (optionally) record, built ENTIRELY from existing primitives.
//
// IDENTITY-MATCH SOUNDNESS (investigated, not assumed — see the task that
// created this module): recording goes through `seedFileBaseline` (adopt.ts),
// which derives identities via
//   deriveIdentities(file, content, adapted.map((m) => m.raw))
// — i.e. FROM the exact array it is about to zip against, inside one `.map()`
// call. `Array.prototype.map` is order-preserving, so `identities[i]`
// corresponds to `adapted[i]` BY CONSTRUCTION, regardless of what order the
// runner emitted its mutants in. "The zip is only sound if the runner returns
// mutants in the same order identity computation produced them" describes a
// DIFFERENT, unsound design — deriving identities independently of the
// runner's own array and then matching positionally — which nothing in this
// codebase does. This module never diverges from the safe recipe: it hands
// the runner's raw JSON to `seedFileBaseline` UNMODIFIED and never separately
// re-derives or re-orders identities itself.
//
// PARTIAL RUNS ARE EXCLUDED BY CONSTRUCTION, not detected after the fact:
// `requestWholeFileReport` below talks to exactly ONE endpoint per attempt
// (redundant failover across configured endpoints, never concurrent
// sharding — contrast with sharded-runner.ts, which fans one file out across
// N runners for the PreToolUse latency budget). A sharded fan-out can succeed
// on some line-range shards and fail on others, and `applyMeasuredRun` has no
// way to distinguish "this symbol has zero mutants because its shard's
// request never completed" from "this symbol genuinely has zero mutable
// expressions" — silently recording the former as a clean symbol. Restricting
// this path to one whole-file answer per attempt makes every recorded run
// atomic: either one endpoint measured the ENTIRE file, or nothing is
// recorded. `measureFile` therefore has exactly three outcomes — "measured"
// (a complete report), "not_measurable" (the runner says so), or "error"
// (nothing usable) — with no fourth "partial" state to smuggle through.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTestPath } from "../coverage-test-selector.js";
import { expectedCompanionTest } from "../coverage-pairing.js";
import { seedFileBaseline } from "./adopt.js";
import { describeErrorResponse, readNotMeasurable } from "./cloud-runner.js";
import { mutationIdentityAvailable } from "./identity.js";
import { collectLocalDeps } from "./local-deps.js";
import { normalizeManifestKey, stampProvenance } from "./manifest.js";
import { strykerToAdapted } from "./stryker-adapter.js";
import type { MeasurementProvenance, MutationManifest } from "./types.js";

// ============================================================
// Wire types
// ============================================================

export interface MeasureOverlay {
	path: string;
	content: string;
}

export interface FetchResponseLike {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	/** Optional so a test double stays a two-method object; real `fetch` always
	 *  has it, and it is the only way to recover an error response's body. */
	text?: () => Promise<string>;
}

export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

// ============================================================
// Overlay construction (companion test + transitive local deps)
// ============================================================

/** Pushes `path`'s content onto `out` if not already present. Returns whether
 *  the path is now represented in `out` (already-present counts as success) —
 *  callers use this to distinguish "added/already there" from "could not be
 *  read", which they must report rather than silently swallow. */
function pushIfNew(out: MeasureOverlay[], path: string, readDisk: (p: string) => string | null): boolean {
	if (out.some((o) => o.path === path)) return true;
	const content = readDisk(path);
	if (content === null) return false;
	out.push({ path, content });
	return true;
}

/**
 * The full overlay set for a whole-file out-of-band measurement: the target,
 * its companion test (if one exists on disk), and both files' transitive local
 * deps — the same shape gate.ts's `buildOverlays` ships for the per-edit path,
 * minus the ChangeSet machinery this single-file caller has no use for.
 *
 * Thin wrapper over {@link buildScopedMeasureOverlays} with an empty test
 * scope — kept as its own export because it is the stable, back-compat shape
 * (a plain array) every existing caller and test already depends on.
 */
export function buildMeasureOverlays(
	file: string,
	content: string,
	readDisk: (path: string) => string | null,
): MeasureOverlay[] {
	return buildScopedMeasureOverlays(file, content, readDisk).overlays;
}

/**
 * Ceiling on distinct files placed in one measurement's overlay set (target +
 * companion + full test scope + their transitive local-dep closure). A test
 * scope widened via the reverse import graph (test-scope.ts) can resolve to
 * dozens of test files (this repo's own worst case, `session-state.ts`,
 * resolves to 61) whose OWN dependency fan-out could in principle be large;
 * this is a belt-and-braces backstop, not the primary bound — the primary
 * bound is `test-scope.ts`'s own `MAX_MUTATION_TEST_SCOPE` (150), which caps
 * how many test files are even considered before this function ever runs.
 * Set comfortably above the measured worst case so a legitimate hub file's
 * complete closure is never truncated in practice, while still refusing to
 * let a pathological fan-in balloon one request without bound.
 */
export const MAX_MEASURE_OVERLAYS = 1400;
// Raised 600 -> 1400 on 2026-08-01 against a MEASURED worst case rather than an
// estimate. A graph-scoped run of `session-state.ts` selects 60 affected tests
// whose transitive closure is 845 files — roughly 80% of the tree, because
// `session-state.ts` is imported by `server.ts` and the server's tests reach
// nearly everything. At 600 the run still failed, just loudly instead of
// silently (245 files dropped and named, versus the earlier truncation at 40
// that reported nothing at all).
//
// 845 is the real number for this repo's worst hub file, so 1400 leaves genuine
// headroom without being unbounded. The bound still exists for a reason: it is
// the difference between "this closure is large" and "a pathological fan-in is
// shipping the universe every request".
//
// Worth recording for the cloud design: when a wide test scope's closure is
// most of the repository, per-job content shipping stops being viable and
// content-addressed storage with dedup becomes a requirement, not an
// optimisation — almost every blob is identical between consecutive jobs.

export interface ScopedOverlayResult {
	overlays: MeasureOverlay[];
	/**
	 * Every path this build needed (target, companion, a scope test, or a
	 * transitive local dep) but could not read from disk. MUST be surfaced by
	 * the caller, never silently dropped — a closure that quietly omits a file
	 * is exactly the failure mode this function exists to close (an
	 * incomplete overlay set looks like a working run until the scope widens
	 * enough to expose the gap).
	 */
	unreadable: string[];
	/**
	 * Present only when the candidate set exceeded {@link MAX_MEASURE_OVERLAYS}
	 * AND at least one file was actually dropped as a result. `file`, the
	 * companion, and every path in the requested `testScope` are NEVER
	 * truncated (the caller explicitly asked for them); only the
	 * dependency-closure overflow can be dropped, and it is named here so a
	 * caller can report it rather than measuring against a silently
	 * incomplete closure. Absent when the required set alone exceeds the cap
	 * (nothing droppable — every requested file is still present, so there is
	 * nothing to warn about).
	 */
	capped?: { limit: number; candidateCount: number; dropped: string[] };
}

/**
 * Full-closure overlay set for a test-SCOPE measurement: the target file, its
 * companion test, EVERY test file in `testScope`, and the transitive
 * local-dep closure of all of them combined — deduped by path.
 *
 * This is what makes a graph-widened test scope (test-scope.ts's
 * reverse-import-graph selection) actually loadable by a runner whose
 * worktree resets to HEAD before each run
 * (scratch/two-box-runner/runner.mjs::resetWorktree): every file Stryker will
 * load must travel as overlay CONTENT, or it comes from the runner's own
 * commit and can be stale relative to the uncommitted edit under measurement.
 * `buildMeasureOverlays` above is the `testScope: []` case of this function.
 */
export function buildScopedMeasureOverlays(
	file: string,
	content: string,
	readDisk: (path: string) => string | null,
	testScope: string[] = [],
): ScopedOverlayResult {
	const out: MeasureOverlay[] = [{ path: file, content }];
	const seeds = [file];
	const unreadable: string[] = [];
	const companion = expectedCompanionTest(file);
	if (companion !== file) {
		if (pushIfNew(out, companion, readDisk)) seeds.push(companion);
	}
	for (const t of testScope) {
		if (out.some((o) => o.path === t)) continue;
		if (pushIfNew(out, t, readDisk)) {
			seeds.push(t);
		} else {
			unreadable.push(t);
		}
	}
	const required = new Set(seeds);
	for (const entry of seeds) {
		// Cap at MAX_MEASURE_OVERLAYS, not collectLocalDeps' default of 40.
		//
		// That default exists for the PER-EDIT gate, where the closure is one file
		// and 40 is generous. On this path a seed can be a large test file whose
		// transitive closure runs to hundreds, and `collectLocalDeps` truncates by
		// simply returning early — no signal, no error.
		//
		// Measured 2026-08-01: a graph-scoped run of session-state.ts shipped 415
		// overlays and STILL failed, because `manifest.ts` made it into the closure
		// while its own import of `manifest-heal.js` (created that same day) fell
		// past the 40-dep cut. The sandbox then had an import pointing at nothing,
		// which Stryker reported as "There were failed tests in the initial test
		// run" — a verdict about the CODE, when the truth was an incomplete
		// closure. This function already refuses to truncate silently at the outer
		// cap; deferring to a smaller inner one undid that guarantee.
		//
		// The outer MAX_MEASURE_OVERLAYS bound below still applies and still
		// reports what it dropped, so raising this cannot produce an unbounded set.
		for (const dep of collectLocalDeps(entry, readDisk, MAX_MEASURE_OVERLAYS)) {
			if (out.some((o) => o.path === dep)) continue;
			if (!pushIfNew(out, dep, readDisk)) unreadable.push(dep);
		}
	}
	if (out.length <= MAX_MEASURE_OVERLAYS) {
		return { overlays: out, unreadable };
	}
	// Overflow: keep every required path (target, companion, every requested
	// scope test) unconditionally and cap only the dependency-closure spill.
	const requiredOverlays = out.filter((o) => required.has(o.path));
	const depOverlays = out.filter((o) => !required.has(o.path));
	const budget = Math.max(0, MAX_MEASURE_OVERLAYS - requiredOverlays.length);
	const kept = depOverlays.slice(0, budget);
	const dropped = depOverlays.slice(budget).map((o) => o.path);
	// If the required set (target + companion + every requested scope file)
	// alone already exceeds the cap, there is nothing droppable — dep spill
	// is empty and truncating would mean silently losing a file the caller
	// explicitly asked for, which this function never does. Report that as an
	// uncapped (if oversized) result rather than a `capped` verdict with
	// nothing actually dropped, which would mislead a caller into thinking
	// the closure is incomplete when in fact every requested file is present.
	if (dropped.length === 0) {
		return { overlays: [...requiredOverlays, ...kept], unreadable };
	}
	return {
		overlays: [...requiredOverlays, ...kept],
		unreadable,
		capped: { limit: MAX_MEASURE_OVERLAYS, candidateCount: out.length, dropped },
	};
}

// ============================================================
// Runner endpoint configuration
// ============================================================

export interface ConfiguredEndpoints {
	endpoints: string[];
	token?: string;
}

/**
 * Runner topology + auth token from the gitignored local rules — the ONE
 * source of truth per repo (mirrors `scratch/measure-file.mts`'s ad hoc
 * reader, now a first-class, unit-testable function instead of a copy living
 * only in a throwaway script).
 */
export function configuredRunnerEndpoints(
	cwd: string,
	readFile: (path: string) => string | null,
): ConfiguredEndpoints {
	const raw = readFile(join(cwd, ".interlinked", "guard-rules.local.json"));
	if (raw === null) return { endpoints: [] };
	try {
		const cfg = JSON.parse(raw) as {
			per_edit_mutation?: { runner_url?: string; runner_urls?: string[]; token?: string };
		};
		const m = cfg.per_edit_mutation ?? {};
		const endpoints = [m.runner_url, ...(m.runner_urls ?? [])].filter(
			(u): u is string => typeof u === "string" && u.length > 0,
		);
		return m.token ? { endpoints, token: m.token } : { endpoints };
	} catch {
		return { endpoints: [] };
	}
}

// ============================================================
// The wire request — ONE whole-file answer per attempt (see module docstring)
// ============================================================

export interface RequestArgs {
	file: string;
	content: string;
	overlays: MeasureOverlay[];
	endpoints: string[];
	token?: string;
	fetchImpl: FetchLike;
	jobId: string;
	/**
	 * Repo-relative test paths selected via the reverse import graph
	 * (`test-scope.ts::computeMutationTestScope`), forwarded so the runner can
	 * use the CORRECT suite instead of its own filename-glob guess. Absent (or
	 * omitted) ⇒ the runner falls back to its existing `testScopeFor` — this is
	 * an additive wire field an older runner can safely ignore.
	 */
	testScope?: string[];
	/** Total time to keep retrying busy/unreachable endpoints before giving up. */
	deadlineMs: number;
	/** Per-request abort timeout. */
	requestTimeoutMs: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export type RequestOutcome =
	| { ok: true; body: unknown }
	| {
			ok: false;
			reason: string;
			/** Set ONLY when every attempt up to the deadline was busy (HTTP 503) or
			 *  unreachable — i.e. no endpoint ever gave a definitive answer. Absent
			 *  for a genuine non-503 HTTP error, which IS a definitive (if unhappy)
			 *  answer. Callers must not fold this into "error": a busy runner has
			 *  said nothing about whether the file has tests, so it must never be
			 *  read as (or reported alongside) a no_tests verdict. */
			busy?: true;
	  };

function headersFor(token?: string): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

function wholeFileRange(content: string): { start: number; end: number } {
	return { start: 1, end: Math.max(1, content.split("\n").length) };
}

/** Whether one endpoint answered with something other than "busy" — the
 *  signal that ends the retry loop, success or failure alike. */
/**
 * One endpoint attempt, with BUSY and UNREACHABLE kept apart.
 *
 * Both used to collapse to `null`, and the caller then retried until its whole
 * deadline elapsed — correct for a contended runner (it will free up) and
 * badly wrong for a disconnected one (it will not). A sweep with a 900s budget
 * spent fifteen minutes per file posting to a laptop that had closed.
 */
type EndpointAttempt =
	| { kind: "response"; res: FetchResponseLike }
	| { kind: "busy" }
	| { kind: "unreachable" };

async function tryEndpoint(
	url: string,
	body: string,
	headers: Record<string, string>,
	fetchImpl: FetchLike,
	requestTimeoutMs: number,
): Promise<EndpointAttempt> {
	try {
		const res = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(requestTimeoutMs) });
		return res.status === 503 ? { kind: "busy" } : { kind: "response", res };
	} catch {
		return { kind: "unreachable" };
	}
}

/**
 * Rounds of "every endpoint refused the connection" before giving up early.
 *
 * More than one, because a single round can fail for reasons that clear on
 * their own — a Wi-Fi handover, a runner restarting, a VPN re-key. Few, because
 * once a host is actually gone, every further round is dead time multiplied by
 * every remaining file.
 */
const UNREACHABLE_ROUNDS_BEFORE_GIVING_UP = 3;

/**
 * POST one whole-file measurement, trying each configured endpoint in turn and
 * retrying the whole round (jittered backoff) until `deadlineMs` elapses.
 * Exactly one endpoint's answer is ever used — see the module docstring for
 * why this never fans the request out across concurrent shards.
 */
export async function requestWholeFileReport(args: RequestArgs): Promise<RequestOutcome> {
	const now = args.now ?? Date.now;
	const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const body = JSON.stringify({
		file: args.file,
		overlayContent: args.content,
		overlays: args.overlays,
		// Explicit whole-file range is load-bearing: the runner adds
		// `--incremental` only for unranged requests, which can replay a stale
		// cached report (measure-file.mts learned this the hard way).
		range: wholeFileRange(args.content),
		job_id: args.jobId,
		// Omitted (not even an empty array) when absent, matching `overlays`'
		// own back-compat convention — an older runner that doesn't recognize
		// the key just ignores it and falls back to its own scoping.
		...(args.testScope ? { testScope: args.testScope } : {}),
	});
	const headers = headersFor(args.token);
	const deadline = now() + args.deadlineMs;
	let attempt = 0;
	let allUnreachableRounds = 0;
	while (now() < deadline) {
		let reachedSomeone = false;
		for (const url of args.endpoints) {
			const attempt = await tryEndpoint(url, body, headers, args.fetchImpl, args.requestTimeoutMs);
			if (attempt.kind === "busy") {
				reachedSomeone = true;
				continue;
			}
			if (attempt.kind === "unreachable") continue;
			const res = attempt.res;
			// Quote the runner rather than reducing it to a status code. This path
			// is the SWEEP's, distinct from cloud-runner.ts's (the per-edit gate's)
			// — the same defect existed in both, and a live 719-file sweep found
			// this copy by reporting a bare `runner HTTP 500` for a file whose
			// runner had explained itself perfectly well.
			if (!res.ok) return { ok: false, reason: await describeErrorResponse(res) };
			return { ok: true, body: await res.json() };
		}
		allUnreachableRounds = reachedSomeone ? 0 : allUnreachableRounds + 1;
		if (allUnreachableRounds >= UNREACHABLE_ROUNDS_BEFORE_GIVING_UP) {
			return {
				ok: false,
				busy: true,
				reason: `runner_unreachable: no runner answered on ${args.endpoints.join(", ")} across ${allUnreachableRounds} rounds — the host is down or the network is gone, NOT evidence this file lacks tests`,
			};
		}
		attempt++;
		const waitMs = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * 750);
		await sleep(waitMs);
	}
	// Every attempt across every round was 503-busy or unreachable — nobody ever
	// gave a definitive answer. That is NOT the same failure as a non-503 HTTP
	// error (handled above, immediately, without this label): this is a
	// contended-but-presumably-working runner, and the caller must be able to
	// tell the two apart rather than reporting either one as "error" generically
	// (and NEVER as a no_tests verdict — the runner never got to answer).
	return {
		ok: false,
		busy: true,
		reason: `runner_busy: all runner(s) busy or unreachable after ${Math.round(args.deadlineMs / 1000)}s — retry later; NOT evidence this file lacks tests`,
	};
}

// ============================================================
// Report summarization (measure-only display — no identity work here)
// ============================================================

export interface SurvivorEntry {
	line: number;
	mutator: string;
	replacement: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object";
}

function mutantLocationLine(m: Record<string, unknown>): number {
	const location = isRecord(m.location) ? m.location : null;
	const start = location && isRecord(location.start) ? location.start : null;
	if (!start || typeof start.line !== "number") return 0;
	return start.line;
}

function toMutantEntry(m: unknown): { mutator: string; replacement: string; status: string; line: number } | null {
	if (!isRecord(m)) return null;
	return {
		mutator: typeof m.mutatorName === "string" ? m.mutatorName : "?",
		replacement: typeof m.replacement === "string" ? m.replacement : "?",
		status: typeof m.status === "string" ? m.status : "?",
		line: mutantLocationLine(m),
	};
}

function rawMutantEntries(body: unknown): Array<{ mutator: string; replacement: string; status: string; line: number }> {
	if (!isRecord(body) || !isRecord(body.files)) return [];
	const out: Array<{ mutator: string; replacement: string; status: string; line: number }> = [];
	for (const fileResult of Object.values(body.files)) {
		if (!isRecord(fileResult) || !Array.isArray(fileResult.mutants)) continue;
		for (const m of fileResult.mutants) {
			const entry = toMutantEntry(m);
			if (entry) out.push(entry);
		}
	}
	return out;
}

function summarizeRawReport(body: unknown): { mutantCount: number; survivors: SurvivorEntry[] } {
	const all = rawMutantEntries(body);
	const survivors = all
		.filter((m) => m.status === "Survived")
		.map((m) => ({ line: m.line, mutator: m.mutator, replacement: m.replacement }));
	return { mutantCount: all.length, survivors };
}

// ============================================================
// The measure-only entry point
// ============================================================

export const DEFAULT_MEASURE_DEADLINE_MS = 900_000;
export const DEFAULT_MEASURE_REQUEST_TIMEOUT_MS = 300_000;

export interface MeasureFileArgs {
	/** Repo-relative path — used verbatim as the request's `file` AND (via
	 *  `normalizeManifestKey`, applied downstream by the recorder) the manifest
	 *  key basis. Callers resolve their own path shape to this form first. */
	file: string;
	content: string;
	overlays: MeasureOverlay[];
	endpoints: string[];
	token?: string;
	fetchImpl: FetchLike;
	jobId?: string;
	deadlineMs?: number;
	requestTimeoutMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** See `RequestArgs.testScope` — forwarded verbatim, untouched here. */
	testScope?: string[];
}

export interface MeasureOutcome {
	/**
	 * "busy" is its OWN terminal state, deliberately distinct from "error": every
	 * attempt up to the deadline was a contended runner (HTTP 503) or unreachable
	 * endpoint, so NOBODY ever answered the question "does this file have
	 * tests?" — reporting that as "error" (implies a broken runner) or, worse,
	 * as "not_measurable" (implies a definitive no_tests verdict) is exactly the
	 * measurement-integrity defect this type exists to prevent. Retry later.
	 */
	status: "measured" | "not_measurable" | "error" | "busy";
	/** Set for "not_measurable" (the runner's own reason), "error", and "busy"
	 *  (why the request could not produce a report). Absent on "measured". */
	reason?: string;
	mutantCount: number;
	survivorCount: number;
	survivors: SurvivorEntry[];
	/** The untouched runner response — present ONLY on "measured", and the ONLY
	 *  thing a caller may pass on to `recordMeasurement`. */
	rawReport?: unknown;
}

/** Measure one file end to end (request → classify → summarize). Never
 *  writes anything — recording is a deliberately separate, explicit step
 *  (`recordMeasurement`) so a caller can always choose measure-only. */
export async function measureFile(args: MeasureFileArgs): Promise<MeasureOutcome> {
	const result = await requestWholeFileReport({
		file: args.file,
		content: args.content,
		overlays: args.overlays,
		endpoints: args.endpoints,
		fetchImpl: args.fetchImpl,
		jobId: args.jobId ?? `measure-${args.file.replace(/\W/g, "-")}-${Date.now().toString(36)}`,
		deadlineMs: args.deadlineMs ?? DEFAULT_MEASURE_DEADLINE_MS,
		requestTimeoutMs: args.requestTimeoutMs ?? DEFAULT_MEASURE_REQUEST_TIMEOUT_MS,
		...(args.token !== undefined ? { token: args.token } : {}),
		...(args.now !== undefined ? { now: args.now } : {}),
		...(args.sleep !== undefined ? { sleep: args.sleep } : {}),
		...(args.testScope !== undefined ? { testScope: args.testScope } : {}),
	});
	if (!result.ok) {
		const status = result.busy ? "busy" : "error";
		return { status, reason: result.reason, mutantCount: 0, survivorCount: 0, survivors: [] };
	}
	const notMeasurable = readNotMeasurable(result.body);
	if (notMeasurable) {
		return {
			status: "not_measurable",
			reason: notMeasurable.detail ? `${notMeasurable.reason}: ${notMeasurable.detail}` : notMeasurable.reason,
			mutantCount: 0,
			survivorCount: 0,
			survivors: [],
		};
	}
	const { mutantCount, survivors } = summarizeRawReport(result.body);
	return { status: "measured", mutantCount, survivorCount: survivors.length, survivors, rawReport: result.body };
}

// ============================================================
// Recording — the ONLY write path, and it goes through seedFileBaseline
// ============================================================

export interface FileSurvivorSummary {
	mutants: number;
	survivors: number;
}

export interface RecordArgs {
	base: MutationManifest;
	/** Same repo-relative path handed to `measureFile` — re-normalized
	 *  internally exactly as `seedFileBaseline`/`applyMeasuredRun` do. */
	file: string;
	content: string;
	/** Must be a "measured" outcome's `rawReport`, untouched. */
	rawReport: unknown;
	at: string;
	cwd?: string;
	/** The conditions this measurement ran under. Omitted ⇒ the file's records
	 *  carry NO provenance and every reader treats them as unqualified — which
	 *  is the honest reading, not a defect. */
	provenance?: Omit<MeasurementProvenance, "at"> | undefined;
}

export interface RecordOutcome {
	recorded: boolean;
	/** Human-readable reason recording was refused — set only when !recorded. */
	reason?: string;
	/** Present only when recorded — the caller persists this via `saveManifest`. */
	manifest?: MutationManifest;
	before: FileSurvivorSummary;
	after?: FileSurvivorSummary;
}

function summarizeManifestFile(manifest: MutationManifest, key: string): FileSurvivorSummary {
	const symbols = manifest.files[key] ?? {};
	let mutants = 0;
	let survivors = 0;
	for (const symbol of Object.values(symbols)) {
		for (const mutant of Object.values(symbol.mutants)) {
			mutants++;
			if (mutant.status === "survived" || mutant.status === "equivalent") survivors++;
		}
	}
	return { mutants, survivors };
}

/**
 * Diagnose why `seedFileBaseline` would refuse (or did refuse) this report.
 * Purely explanatory — re-derives NOTHING that gets written; the actual
 * admission decision is `seedFileBaseline`'s alone, checked in the same order
 * its own guards run (test-target, TS availability, unrecognizable/empty
 * report) so this never claims a reason `seedFileBaseline` didn't actually act on.
 */
function explainRefusal(key: string, rawReport: unknown): string {
	if (isTestPath(key)) {
		return "test files are not mutation targets — mutating a test proves nothing (the test is the oracle)";
	}
	if (!mutationIdentityAvailable()) {
		return "the TypeScript API is unavailable — install the `typescript` optionalDependency to enable identity-based recording";
	}
	const adapted = strykerToAdapted(rawReport);
	if (adapted === null) return "the runner response was not a recognizable mutation report";
	const forFile = adapted.find((f) => f.file === key) ?? adapted[0];
	if (forFile === undefined || forFile.mutants.length === 0) {
		return "the runner reported zero mutants for this file — nothing to record";
	}
	return "seedFileBaseline rejected the report for an unrecognized reason — this indicates a bug in this diagnostic, not a safe write";
}

/**
 * Record a measured run into the manifest through `seedFileBaseline` (adopt.ts)
 * — the SAME primitive the brownfield-adoption sweep already uses. Never
 * constructs a `SymbolRecord`/`MutantRecord` by hand: every field of the
 * returned manifest traces through `applyMeasuredRun`'s existing key
 * normalization, test-file rejection, and instability bookkeeping.
 *
 * Callers MUST only invoke this with a "measured" `MeasureOutcome`'s
 * `rawReport` — `measureFile` never returns one for "not_measurable" or
 * "error", so a caller that only records on `status === "measured"` (as the
 * CLI command does) cannot reach this with a partial or failed run.
 */
export function recordMeasurement(args: RecordArgs): RecordOutcome {
	const key = normalizeManifestKey(args.file, args.cwd);
	const before = summarizeManifestFile(args.base, key);
	const seeded = seedFileBaseline({
		base: args.base,
		file: args.file,
		content: args.content,
		report: args.rawReport,
		at: args.at,
		...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
	});
	if (seeded === null) return { recorded: false, reason: explainRefusal(key, args.rawReport), before };
	// Stamp the regime alongside the records it produced. A survivor count is
	// only comparable to another one measured the same way — see
	// `MeasurementScope` for the 186-vs-18 measurement that forced this.
	const manifest = args.provenance
		? stampProvenance({
				manifest: seeded,
				file: args.file,
				provenance: { ...args.provenance, at: args.at },
				...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
			})
		: seeded;
	return { recorded: true, manifest, before, after: summarizeManifestFile(manifest, key) };
}

/** Convenience for CLI/script callers that just want to read a file off disk;
 *  not used by the pure functions above (which all take an injected reader). */
export function readDiskSafe(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}
