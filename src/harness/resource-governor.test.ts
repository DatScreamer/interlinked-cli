import { describe, expect, it } from "vitest";
import {
	backgroundPrefix,
	type GovernorInput,
	planResources,
} from "./resource-governor.js";

function input(overrides: Partial<GovernorInput> = {}): GovernorInput {
	return {
		cores: 10,
		load1: 0,
		agentCount: 1,
		platform: "darwin",
		...overrides,
	};
}

describe("backgroundPrefix", () => {
	it("uses taskpolicy -b on macOS", () => {
		expect(backgroundPrefix("darwin")).toBe("taskpolicy -b ");
	});
	it("uses nice on Linux", () => {
		expect(backgroundPrefix("linux")).toBe("nice -n 19 ");
	});
	it("is empty (no portable equivalent) elsewhere", () => {
		expect(backgroundPrefix("win32")).toBe("");
	});
});

describe("planResources — job cap", () => {
	it("caps at ~half the cores on a quiet machine", () => {
		const p = planResources(input({ cores: 10, load1: 0 }));
		expect(p.maxJobs).toBe(5);
		expect(p.defer).toBe(false);
		expect(p.background).toBe(true);
		expect(p.commandPrefix).toBe("taskpolicy -b ");
	});

	it("honors an explicit max_jobs config", () => {
		const p = planResources(input({ cores: 16, config: { max_jobs: 3 } }));
		expect(p.maxJobs).toBe(3);
	});

	it("never returns fewer than 1 job on a quiet single-core box", () => {
		const p = planResources(input({ cores: 1, load1: 0 }));
		expect(p.maxJobs).toBe(1);
	});
});

describe("planResources — load sensing", () => {
	it("halves jobs when per-core load crosses the load threshold", () => {
		// 10 cores, load 8 → per-core 0.8 ≥ 0.7 → base 5 halved to 2.
		const p = planResources(input({ cores: 10, load1: 8 }));
		expect(p.maxJobs).toBe(2);
		expect(p.defer).toBe(false);
	});

	it("defers the heavy lane entirely when load is very high", () => {
		// 10 cores, load 16 → per-core 1.6 ≥ 1.5 → defer.
		const p = planResources(input({ cores: 10, load1: 16 }));
		expect(p.defer).toBe(true);
		expect(p.maxJobs).toBe(0);
		expect(p.reason).toContain("deferring");
	});

	it("treats unknown load (0) as a quiet machine (fail-open)", () => {
		const p = planResources(input({ cores: 8, load1: 0 }));
		expect(p.defer).toBe(false);
		expect(p.maxJobs).toBe(4);
	});
});

describe("planResources — agent sharing + CPU budget", () => {
	it("shares cores across concurrent agents", () => {
		// base 5 / 2 agents → 2.
		const p = planResources(input({ cores: 10, agentCount: 2 }));
		expect(p.maxJobs).toBe(2);
		expect(p.reason).toContain("shared across 2 agents");
	});

	it("caps jobs by the CPU-second budget", () => {
		// base 5, but budget 40s / est 20s per job → 2 jobs.
		const p = planResources(
			input({ cores: 10, estJobWallSec: 20, config: { cpu_budget_sec: 40 } }),
		);
		expect(p.maxJobs).toBe(2);
		expect(p.reason).toContain("CPU-budget");
	});

	it("ignores the CPU budget when no per-job estimate is given", () => {
		const p = planResources(input({ cores: 10, config: { cpu_budget_sec: 40 } }));
		expect(p.maxJobs).toBe(5);
	});
});
