import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../cohort.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";
import type { HarnessEvent } from "../types.js";
import { evaluatePostToolUse } from "./post-tool.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("evaluatePostToolUse apply_patch reservation cleanup", () => {
	it("schedules every patch destination and move source without releasing unrelated leases", () => {
		vi.useFakeTimers();
		const cwd = "/repo/worktree";
		const agentName = "parallel-codex-child";
		const cohort = new CohortManager();
		const reservations = new ReservationManager();
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/old.ts",
			"*** Move to: src/new.ts",
			"@@",
			"-old",
			"+new",
			"*** Add File: docs/a.md",
			"+hello",
			"*** End Patch",
		].join("\n");
		const patchPaths = ["src/new.ts", "src/old.ts", "docs/a.md"].map((path) =>
			resolve(cwd, path),
		);
		const unrelated = resolve(cwd, "src/unrelated.ts");
		for (const path of [...patchPaths, unrelated]) {
			reservations.checkAndReserve(path, agentName, cohort);
		}

		const event: HarnessEvent = {
			hook_event: "PostToolUse",
			session_id: "reservation-cleanup-test",
			agent_source: "codex",
			agent_name: agentName,
			tool_name: "apply_patch",
			tool_input: { command: patch },
			cwd,
			timestamp: "2026-08-30T00:00:00.000Z",
		};

		expect(
			evaluatePostToolUse(
				event,
				getDefaultConfig(),
				undefined,
				reservations,
				cohort,
			).decision,
		).toBe("allow");
		vi.advanceTimersByTime(31_000);

		expect(reservations.getAll().map((entry) => entry.file_pattern)).toEqual([unrelated]);
	});
});
