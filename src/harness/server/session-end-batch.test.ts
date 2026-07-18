import { afterEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import type { ResourcePlan } from "../resource-governor.js";
import type { HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";
import {
	governedSpawn,
	runSessionEndJobs,
	runSessionEndResourcePlan,
	type SessionEndJobDeps,
} from "./session-end-batch.js";

type SpawnFn = NonNullable<SessionEndJobDeps["spawn"]>;

function sessionEnd(sessionId = "s1"): HarnessEvent {
	return {
		hook_event: "SessionEnd",
		session_id: sessionId,
		agent_source: "claude",
		tool_input: {},
		cwd: "/repo",
		timestamp: "t",
	};
}

function makeCtx(over: Record<string, unknown> = {}): ServerRuntime {
	const logLines: string[] = [];
	const base = {
		cwd: "/repo",
		rules: {},
		cohort: new CohortManager(),
		log: (msg: string) => {
			logLines.push(msg);
		},
		logAlways: () => {},
		_logLines: logLines,
	};
	return { ...base, ...over } as unknown as ServerRuntime;
}

describe("runSessionEndResourcePlan", () => {
	it("returns a valid resource plan for the current machine", () => {
		const ctx = makeCtx();
		const plan = runSessionEndResourcePlan(ctx, sessionEnd());
		expect(plan).not.toBeNull();
		expect(plan?.maxJobs).toBeGreaterThanOrEqual(0);
		expect(typeof plan?.defer).toBe("boolean");
		expect(plan?.reason.length).toBeGreaterThan(0);
	});

	it("logs the plan with the session id", () => {
		const logLines: string[] = [];
		const ctx = makeCtx({
			log: (m: string) => {
				logLines.push(m);
			},
		});
		runSessionEndResourcePlan(ctx, sessionEnd("abc"));
		expect(logLines.some((l) => l.includes("abc") && l.includes("resource plan"))).toBe(true);
	});

	it("never throws even if the cohort read fails (never-throw contract)", () => {
		const brokenCohort = {
			getActiveAgents() {
				throw new Error("cohort exploded");
			},
		};
		const ctx = makeCtx({ cohort: brokenCohort });
		expect(() => runSessionEndResourcePlan(ctx, sessionEnd())).not.toThrow();
		expect(runSessionEndResourcePlan(ctx, sessionEnd())).toBeNull();
	});
});

describe("governedSpawn", () => {
	it("runs the command directly when there is no priority prefix", () => {
		const { file, args } = governedSpawn("", "/node", ["cli.js", "recurrence"]);
		expect(file).toBe("/node");
		expect(args).toEqual(["cli.js", "recurrence"]);
	});

	it("wraps in taskpolicy on macOS", () => {
		const { file, args } = governedSpawn("taskpolicy -b ", "/node", ["cli.js", "scan"]);
		expect(file).toBe("taskpolicy");
		expect(args).toEqual(["-b", "/node", "cli.js", "scan"]);
	});

	it("wraps in nice on Linux", () => {
		const { file, args } = governedSpawn("nice -n 19 ", "/node", ["cli.js"]);
		expect(file).toBe("nice");
		expect(args).toEqual(["-n", "19", "/node", "cli.js"]);
	});
});

describe("runSessionEndJobs", () => {
	const activePlan: ResourcePlan = {
		maxJobs: 4,
		background: true,
		commandPrefix: "taskpolicy -b ",
		defer: false,
		reason: "quiet",
	};

	afterEach(() => {
		delete process.env.INTERLINKED_DISABLE_SESSION_END_JOBS;
	});

	function fakeChild() {
		return { on() {}, unref() {} };
	}

	it("spawns each governed job with the priority-wrapped argv", () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		const spawn = ((file: string, args: string[]) => {
			calls.push({ file, args });
			return fakeChild();
		}) as unknown as SpawnFn;
		runSessionEndJobs(makeCtx(), activePlan, {
			spawn,
			cliEntry: "/repo/dist/index.js",
			execPath: "/node",
		});
		// Job 4 (recurrence scan) + Job 1 (coverage ratchet), both taskpolicy-wrapped.
		expect(calls).toHaveLength(2);
		for (const c of calls) {
			expect(c.file).toBe("taskpolicy");
			expect(c.args.slice(0, 3)).toEqual(["-b", "/node", "/repo/dist/index.js"]);
		}
		const commands = calls.map((c) => c.args.slice(3).join(" "));
		expect(commands).toContain("recurrence scan --record");
		expect(commands).toContain("coverage check --update-baseline");
	});

	it("does NOT spawn when the governor defers (busy machine)", () => {
		let spawned = false;
		const spawn = (() => {
			spawned = true;
			return fakeChild();
		}) as unknown as SpawnFn;
		runSessionEndJobs(makeCtx(), { ...activePlan, defer: true }, { spawn });
		expect(spawned).toBe(false);
	});

	it("does NOT spawn when opted out via env", () => {
		process.env.INTERLINKED_DISABLE_SESSION_END_JOBS = "1";
		let spawned = false;
		const spawn = (() => {
			spawned = true;
			return fakeChild();
		}) as unknown as SpawnFn;
		runSessionEndJobs(makeCtx(), activePlan, { spawn });
		expect(spawned).toBe(false);
	});

	it("never throws when spawn itself fails", () => {
		const spawn = (() => {
			throw new Error("ENOENT");
		}) as unknown as SpawnFn;
		expect(() =>
			runSessionEndJobs(makeCtx(), activePlan, { spawn, cliEntry: "x", execPath: "y" }),
		).not.toThrow();
	});
});
