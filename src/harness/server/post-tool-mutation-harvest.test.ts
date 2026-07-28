import { beforeEach, describe, expect, it } from "vitest";
import { overlayHash, pendingRegistry, resetPendingRegistry } from "../mutation/pending-registry.js";
import { recordPending } from "../mutation/pending-runs.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { appendMutationHarvestWarning } from "./post-tool-mutation-harvest.js";
import type { ServerRuntime } from "./runtime-context.js";

const NOW = 1_800_000_000_000;
const CONTENT = "export function f(x: number) { return x > 0; }\n";

const REPORT = {
	files: {
		"src/a.ts": {
			source: CONTENT,
			mutants: [
				{
					mutatorName: "EqualityOperator",
					replacement: ">=",
					status: "Survived",
					location: { start: { line: 1, column: 39 }, end: { line: 1, column: 40 } },
				},
			],
		},
	},
};

function ctxWith(enabled: boolean, cwd: string) {
	return {
		cwd,
		rules: { per_edit_mutation: { enabled, runner_urls: ["http://runner/"] } },
	} as unknown as ServerRuntime;
}

function writeEvent(path: string): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		tool_name: "Edit",
		tool_input: { file_path: path },
	} as unknown as HarnessEvent;
}

const okFetch = async () => ({ ok: true, status: 200, json: async () => REPORT });

beforeEach(() => {
	resetPendingRegistry();
});

describe("appendMutationHarvestWarning", () => {
	it("reports survivors from a run the PreToolUse window could not wait for", async () => {
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(decision.warnings?.join("\n")).toContain("surviving mutant");
	});

	it("waits for a run that is still going when the phase starts", async () => {
		// The whole point of the second window: PostToolUse fires milliseconds
		// after the write while the run still needs seconds.
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		let t = NOW;
		let calls = 0;
		const readyOnThirdTry = async () => {
			calls++;
			if (calls < 3) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => REPORT };
		};
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => CONTENT,
			fetchImpl: readyOnThirdTry,
			now: () => t,
			sleep: async (ms: number) => {
				t += ms;
			},
		});
		expect(calls).toBe(3);
		expect(decision.warnings?.join("\n")).toContain("surviving mutant");
	});

	it("reports a measured-clean result rather than staying silent about it", async () => {
		// Silence made the path unobservable: "claimed, waited, nothing survived"
		// looked identical to "never correlated at all". The agent should be able
		// to see the clean result it earned.
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const noSurvivors = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ files: { "src/a.ts": { source: CONTENT, mutants: [] } } }),
		});
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => CONTENT,
			fetchImpl: noSurvivors,
			now: () => NOW,
		});
		expect(decision.warnings?.join("\n")).toContain("measured clean");
	});

	it("reports pending runs that never came back, instead of implying clean", async () => {
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const refused = async () => {
			throw new Error("connection refused");
		};
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => CONTENT,
			fetchImpl: refused,
			now: () => NOW,
		});
		const text = decision.warnings?.join("\n") ?? "";
		expect(text).toContain("not measured");
		expect(text).not.toContain("clean");
	});

	it("says nothing when no run is pending for the edited file", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, process.cwd()), writeEvent("/x/src/a.ts"), decision, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(decision.warnings ?? []).toHaveLength(0);
	});

	it("does not claim a run whose measured bytes are not the bytes that landed", async () => {
		// The safety property: an edit that changed after measurement, or a
		// different concurrent edit, must MISS rather than report a wrong answer.
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
			readDisk: () => "totally different content\n",
			fetchImpl: okFetch,
			now: () => NOW,
		});
		const text = decision.warnings?.join("\n") ?? "";
		// It must not report the measured survivors against text they were not
		// measured against — but it must SAY the guard fired, because a silent
		// miss is indistinguishable from "nothing was running" and hid a live
		// key-format bug for a whole session.
		expect(text).not.toContain("surviving mutant");
		expect(text).toContain("could not be matched");
	});

	it("stays silent when the feature is disabled", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendMutationHarvestWarning(ctxWith(false, process.cwd()), writeEvent("/x/src/a.ts"), decision, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(decision.warnings ?? []).toHaveLength(0);
	});

	it("never throws when the runner is unreachable — the write already happened", async () => {
		const cwd = process.cwd();
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: overlayHash(CONTENT),
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		const decision: HarnessDecision = { decision: "allow" };
		const boom = async () => {
			throw new Error("connection refused");
		};
		await expect(
			appendMutationHarvestWarning(ctxWith(true, cwd), writeEvent(`${cwd}/src/a.ts`), decision, {
				readDisk: () => CONTENT,
				fetchImpl: boom,
				now: () => NOW,
			}),
		).resolves.toBeUndefined();
		// It reports the unmeasured outcome rather than staying silent, but the
		// property under test here is that nothing escapes into the hook.
		expect(decision.warnings?.join("\n")).toContain("not measured");
	});

	it("ignores events that are not file writes", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		const bashEvent = {
			hook_event: "PostToolUse",
			session_id: "s",
			tool_name: "Bash",
			tool_input: { command: "ls" },
		} as unknown as HarnessEvent;
		await appendMutationHarvestWarning(ctxWith(true, process.cwd()), bashEvent, decision, {
			readDisk: () => CONTENT,
			fetchImpl: okFetch,
			now: () => NOW,
		});
		expect(decision.warnings ?? []).toHaveLength(0);
	});
});
