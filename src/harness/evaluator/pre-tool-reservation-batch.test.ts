import { describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { ReservationManager } from "../reservations.js";
import type { HarnessEvent } from "../types.js";
import { evaluateAutoReservation } from "./pre-tool-decision-phases.js";

describe("evaluateAutoReservation multi-path acquisition", () => {
	it("leaves no earlier patch lease behind when a later path blocks", () => {
		const cwd = "/repo";
		const cohort = new CohortManager();
		const reservations = new ReservationManager();
		reservations.checkAndReserve(`${cwd}/src/b.ts`, "remote-holder", cohort);
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			"@@",
			"-a",
			"+A",
			"*** Update File: src/b.ts",
			"@@",
			"-b",
			"+B",
			"*** End Patch",
		].join("\n");
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "batch-reservation-test",
			agent_source: "codex",
			agent_name: "writer",
			tool_name: "apply_patch",
			tool_input: { command: patch },
			cwd,
			timestamp: "2026-08-30T00:00:00.000Z",
		};

		const result = evaluateAutoReservation(
			event,
			undefined,
			"apply_patch",
			event.tool_input ?? {},
			reservations,
			cohort,
			[],
		);

		expect(result?.decision).toBe("block");
		expect(result?.reservation?.file).toBe(`${cwd}/src/b.ts`);
		expect(reservations.getForAgent("writer")).toEqual([]);
		expect(reservations.getAll().map((entry) => entry.file_pattern)).toEqual([
			`${cwd}/src/b.ts`,
		]);
	});
});
