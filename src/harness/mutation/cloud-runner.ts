// ===========================================
// Per-edit mutation — cloud runner client (build steps 4–5, daemon side)
// ===========================================
// The daemon-side MutationRunner: forward the edited file + its proposed overlay
// content to the cloud Worker, which runs Stryker inside a Sandbox and returns a
// mutation-testing report; adapt that into RawMutants. This is the VERIFIABLE
// half of the runner (unit-tested with an injected fetch); the Worker
// (cloud/mutation-worker/) is the deploy-gated half. A non-ok response /
// unrecognized report THROWS — the gate turns that into an honest not-measured
// allow, never a forged clean pass (spec §12).

import { isJsonObject } from "../../lib/json-types.js";
import type { MutationRunner } from "./gate.js";
import { strykerToAdapted } from "./stryker-adapter.js";
import type { TestRunResult } from "./types.js";

export interface CloudRunnerConfig {
	url: string;
	token?: string | undefined;
	timeoutMs: number;
}

/**
 * Thrown when the budget expired before the runner answered.
 *
 * Carries the job handle so the caller can claim the result in a LATER window
 * rather than discarding work the engine has already paid for. The id is minted
 * by the CLIENT before the request precisely so it survives this case — a
 * server-minted id would only ever arrive in the response we just gave up on.
 *
 * It is still an error, not a result: the caller must report honest
 * not-measured for this window and only upgrade if the harvest succeeds.
 */

/** Structured "nothing to measure" payload, if the runner sent one. Exported so
 *  `measure.ts` (the out-of-band single-file path) shares this ONE parser
 *  rather than growing its own second reading of the same wire shape. */
export function readNotMeasurable(body: unknown): { reason: string; detail?: string } | null {
	if (typeof body !== "object" || body === null) return null;
	const raw = (body as { not_measurable?: unknown }).not_measurable;
	if (typeof raw !== "object" || raw === null) return null;
	const reason = (raw as { reason?: unknown }).reason;
	if (typeof reason !== "string" || reason === "") return null;
	const detail = (raw as { detail?: unknown }).detail;
	return typeof detail === "string" ? { reason, detail } : { reason };
}

/**
 * The runner answered, and the honest answer is "there is nothing to measure
 * here" — most often because no test exercises the target file.
 *
 * This is NOT a runner failure, and collapsing the two costs real time: a whole
 * session was spent debugging "the mutation runner failed" that actually meant
 * "the engine ran zero tests because this file has no companion test". It is
 * also the more USEFUL signal of the two — a file with no tests is precisely
 * what a test-enforcement harness should be saying out loud.
 */
export class MutationNotMeasurableError extends Error {
	readonly reason: string;

	constructor(reason: string, detail?: string) {
		super(detail ? `${reason}: ${detail}` : reason);
		this.name = "MutationNotMeasurableError";
		this.reason = reason;
	}
}

export class MutationRunPendingError extends Error {
	readonly jobId: string;
	readonly runnerUrl: string;

	constructor(jobId: string, runnerUrl: string) {
		super(`mutation run still pending (job ${jobId})`);
		this.name = "MutationRunPendingError";
		this.jobId = jobId;
		this.runnerUrl = runnerUrl;
	}
}

/**
 * The runner answered HTTP 503 — a single-worktree runner's honest "I am
 * currently running someone else's job" signal (`scratch/two-box-runner/runner.mjs`'s
 * `busy` lock), never a body the runner composed by actually attempting the run.
 *
 * This MUST stay distinct from both `MutationNotMeasurableError` (a completed,
 * definitive "no test exercises this file" verdict the runner reached BY
 * running) and a generic non-ok Error (an actually broken runner). Collapsing
 * "busy" into either of those is exactly the measurement-integrity defect this
 * type exists to prevent: a contended runner is not evidence of an absent
 * test, and a caller that cannot tell the two apart silently drops the file
 * out of the denominator every time the fleet is loaded.
 */
export class MutationRunnerBusyError extends Error {
	constructor() {
		super("mutation runner is busy with another job (HTTP 503) — not measured, not evidence of no_tests");
		this.name = "MutationRunnerBusyError";
	}
}

/** Distinct per request; the runner keys its retained report by this. */
function mintJobId(): string {
	return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface FetchResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	/** Optional so an injected test double stays a two-method object. Real
	 *  `fetch` always provides it, and it is the ONLY way to recover the body of
	 *  an error response — see `describeErrorResponse`. */
	text?: () => Promise<string>;
}

/** How much of a runner's error body to carry into the harness message. Long
 *  enough for a stack's first frames, short enough not to flood a hook warning. */
export const ERROR_BODY_CHARS = 400;

/**
 * Turn a non-ok response into a message that says what actually went wrong.
 *
 * The status alone was all this client kept, and it was the least useful thing
 * available: `mutation runner HTTP 500` reached the agent as "the mutation
 * runner failed", with the runner's own explanation — clone failed, install
 * failed, engine crashed, wrong repo — discarded one function call from where
 * it arrived. A runner that bothers to explain itself must be quoted, not
 * summarized into a status code.
 *
 * Never throws: a body that cannot be read degrades to the bare status, which
 * is exactly the previous behavior.
 */
export async function describeErrorResponse(res: FetchResponse): Promise<string> {
	const detail = await readErrorBody(res);
	return detail === null
		? `mutation runner HTTP ${res.status}`
		: `mutation runner HTTP ${res.status}: ${detail}`;
}

async function readErrorBody(res: FetchResponse): Promise<string | null> {
	if (!res.text) return null;
	try {
		const raw = (await res.text()).trim();
		if (raw === "") return null;
		return collapse(extractMessage(raw)).slice(0, ERROR_BODY_CHARS);
	} catch {
		return null;
	}
}

/** Prefer a JSON body's own error field; fall back to the raw text. */
function extractMessage(raw: string): string {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "string") return parsed;
		if (isJsonObject(parsed)) {
			for (const key of ["error", "message", "detail", "reason"]) {
				const value = parsed[key];
				if (typeof value === "string" && value.trim() !== "") return value;
			}
		}
	} catch {
		// Not JSON — the raw text IS the message.
	}
	return raw;
}

/** One line, so a multi-line stack cannot wreck a terminal warning's shape. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<FetchResponse>;

function headersFor(config: CloudRunnerConfig): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (config.token) headers.authorization = `Bearer ${config.token}`;
	return headers;
}

/** Parse the optional overlay test-run signal from the Worker response (spec §7).
 *  Absent / malformed ⇒ undefined — a mutants-only response gates neither red/green
 *  nor RED-witness, exactly as before the Worker started reporting it. */
function parseTestRun(body: unknown): TestRunResult | undefined {
	if (!isJsonObject(body) || !isJsonObject(body.testRun)) return undefined;
	const overlayGreen = body.testRun.overlayGreen;
	if (typeof overlayGreen !== "boolean") return undefined;
	const witness = body.testRun.redWitnessSatisfied;
	return { overlayGreen, redWitnessSatisfied: typeof witness === "boolean" ? witness : null };
}

/** Daemon-side MutationRunner forwarding to the cloud Sandbox Worker (spec §8). */
export function createCloudMutationRunner(config: CloudRunnerConfig, fetchImpl: FetchLike): MutationRunner {
	return {
		available: () => config.url.length > 0,
		run: async (file, overlayContent, overlays, range) => {
			const controller = new AbortController();
			const jobId = mintJobId();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, config.timeoutMs);
			try {
				const res = await fetchImpl(config.url, {
					method: "POST",
					headers: headersFor(config),
					// `overlays` (full proposed state incl. the companion test) is
					// omitted when absent — an older Worker just ignores it.
					// `range` restricts the run to one line span. Forgetting to forward
					// it (as this did until 2026-07-27) is silent and expensive: every
					// shard measures the WHOLE file, so N runners do N times the work
					// for 1x the coverage and every mutant is reported N times.
					body: JSON.stringify({ file, overlayContent, overlays, range, job_id: jobId }),
					signal: controller.signal,
				});
				// 503 is the single-worktree runner's "busy" lock, which is neither a
				// failure nor evidence of a missing test — throw the dedicated type here
				// rather than leaving `gate.ts` to recover it from message text.
				if (res.status === 503) throw new MutationRunnerBusyError();
				if (!res.ok) throw new Error(await describeErrorResponse(res));
				const body = await res.json();
				// A runner that knows WHY it produced nothing says so, rather than
				// leaving the gate to report a generic failure.
				const notMeasurable = readNotMeasurable(body);
				if (notMeasurable) throw new MutationNotMeasurableError(notMeasurable.reason, notMeasurable.detail);
				const adapted = strykerToAdapted(body);
				if (adapted === null) throw new Error("unrecognized mutation report");
				const mutants = adapted.flatMap((f) => f.mutants);
				const testRun = parseTestRun(body);
				return testRun ? { mutants, testRun } : { mutants };
			} catch (err) {
				// Budget expiry is NOT the same failure as a broken runner. The engine
				// is still working and the result is retained under our job id, so
				// surface a handle the caller can harvest in its next window instead
				// of throwing away work that is already paid for.
				if (timedOut) throw new MutationRunPendingError(jobId, config.url);
				throw err;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
