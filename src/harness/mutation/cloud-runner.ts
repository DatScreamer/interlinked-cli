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

import type { MutationRunner } from "./gate.js";
import { strykerToAdapted } from "./stryker-adapter.js";
import type { TestRunResult } from "./types.js";

export interface CloudRunnerConfig {
	url: string;
	token?: string | undefined;
	timeoutMs: number;
}

export interface FetchResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
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

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object";
}

/** Parse the optional overlay test-run signal from the Worker response (spec §7).
 *  Absent / malformed ⇒ undefined — a mutants-only response gates neither red/green
 *  nor RED-witness, exactly as before the Worker started reporting it. */
function parseTestRun(body: unknown): TestRunResult | undefined {
	if (!isRecord(body) || !isRecord(body.testRun)) return undefined;
	const overlayGreen = body.testRun.overlayGreen;
	if (typeof overlayGreen !== "boolean") return undefined;
	const witness = body.testRun.redWitnessSatisfied;
	return { overlayGreen, redWitnessSatisfied: typeof witness === "boolean" ? witness : null };
}

/** Daemon-side MutationRunner forwarding to the cloud Sandbox Worker (spec §8). */
export function createCloudMutationRunner(config: CloudRunnerConfig, fetchImpl: FetchLike): MutationRunner {
	return {
		available: () => config.url.length > 0,
		run: async (file, overlayContent, overlays) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), config.timeoutMs);
			try {
				const res = await fetchImpl(config.url, {
					method: "POST",
					headers: headersFor(config),
					// `overlays` (full proposed state incl. the companion test) is
					// omitted when absent — an older Worker just ignores it.
					body: JSON.stringify({ file, overlayContent, overlays }),
					signal: controller.signal,
				});
				if (!res.ok) throw new Error(`mutation runner HTTP ${res.status}`);
				const body = await res.json();
				const adapted = strykerToAdapted(body);
				if (adapted === null) throw new Error("unrecognized mutation report");
				const mutants = adapted.flatMap((f) => f.mutants);
				const testRun = parseTestRun(body);
				return testRun ? { mutants, testRun } : { mutants };
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
