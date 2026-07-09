// Regression tests for defect 0 (docs/design/cohort-git-discipline.md):
// apply_patch writes took NO file reservation — the tool passes isFileWrite,
// but its tool_input carries a patch envelope and never a `file_path`, so
// evaluateAutoReservation returned null before leasing anything. A Claude and
// a Codex session in one tree were unprotected by construction (observed live
// 2026-07-09: four grants from one session, zero from the other, one lost
// update on docs/external-pulse/bun-in-rust.md).

import { describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { ReservationManager } from "../reservations.js";
import type { HarnessEvent } from "../types.js";
import { evaluateAutoReservation } from "./pre-tool-decision-phases.js";

const CWD = "/repo";

function patchEvent(command: string, agentName = "codex-session"): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s-codex",
		agent_source: "codex",
		agent_name: agentName,
		tool_name: "apply_patch",
		tool_input: { command },
		cwd: CWD,
		timestamp: "2026-07-09T00:00:00Z",
	};
}

function evaluate(
	event: HarnessEvent,
	reservations: ReservationManager,
	cohort: CohortManager,
	warnings: string[] = [],
) {
	return evaluateAutoReservation(
		event,
		undefined,
		event.tool_name ?? "",
		(event.tool_input ?? {}) as Record<string, unknown>,
		reservations,
		cohort,
		warnings,
	);
}

/** True when `holder` already has a live lease on `path` (probe via a foreign agent). */
function isLeased(reservations: ReservationManager, cohort: CohortManager, path: string): boolean {
	return reservations.checkAndReserve(path, "lease-probe-agent", cohort) !== null;
}

const TWO_FILE_PATCH = [
	"*** Begin Patch",
	"*** Update File: src/a.ts",
	"@@",
	"-old",
	"+new",
	"*** Update File: docs/b.md",
	"@@",
	"-x",
	"+y",
	"*** End Patch",
].join("\n");

describe("evaluateAutoReservation — apply_patch leasing (defect 0)", () => {
	it("leases EVERY section path of an apply_patch envelope", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		const decision = evaluate(patchEvent(TWO_FILE_PATCH), reservations, cohort);
		expect(decision).toBeNull();
		expect(isLeased(reservations, cohort, `${CWD}/src/a.ts`)).toBe(true);
		expect(isLeased(reservations, cohort, `${CWD}/docs/b.md`)).toBe(true);
	});

	it("leases BOTH the source and destination of a Move section", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		const movePatch = [
			"*** Begin Patch",
			"*** Update File: src/old-name.ts",
			"*** Move to: src/new-name.ts",
			"@@",
			"-a",
			"+b",
			"*** End Patch",
		].join("\n");
		expect(evaluate(patchEvent(movePatch), reservations, cohort)).toBeNull();
		expect(isLeased(reservations, cohort, `${CWD}/src/old-name.ts`)).toBe(true);
		expect(isLeased(reservations, cohort, `${CWD}/src/new-name.ts`)).toBe(true);
	});

	it("blocks when a section path is held by a REMOTE agent", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		// "remote-holder" is never registered in the cohort → its lease reads remote.
		reservations.checkAndReserve(`${CWD}/docs/b.md`, "remote-holder", cohort);
		const decision = evaluate(patchEvent(TWO_FILE_PATCH), reservations, cohort);
		expect(decision?.decision).toBe("block");
		expect(decision?.reservation?.file).toBe(`${CWD}/docs/b.md`);
		expect(decision?.reason).toContain("remote-holder");
	});

	it("warns (does not block) when a section path is held by a LOCAL sibling", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		cohort.agentJoined({
			hook_event: "SessionStart",
			session_id: "s-sib",
			agent_source: "claude",
			agent_name: "sibling-agent",
			timestamp: "2026-07-09T00:00:00Z",
		});
		reservations.checkAndReserve(`${CWD}/src/a.ts`, "sibling-agent", cohort);
		const warnings: string[] = [];
		const decision = evaluate(patchEvent(TWO_FILE_PATCH), reservations, cohort, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes('sibling agent "sibling-agent"'))).toBe(true);
		// The non-conflicting section is still leased.
		expect(isLeased(reservations, cohort, `${CWD}/docs/b.md`)).toBe(true);
	});

	it("keeps the named file_path fast path for Write/Edit tools", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			agent_name: "writer",
			tool_name: "Write",
			tool_input: { file_path: `${CWD}/src/c.ts`, content: "x" },
			cwd: CWD,
			timestamp: "2026-07-09T00:00:00Z",
		};
		expect(evaluate(event, reservations, cohort)).toBeNull();
		expect(isLeased(reservations, cohort, `${CWD}/src/c.ts`)).toBe(true);
	});

	it("fails open on an apply_patch payload that is not patch-shaped", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		const decision = evaluate(patchEvent("plain prose, no directives"), reservations, cohort);
		expect(decision).toBeNull();
		expect(isLeased(reservations, cohort, `${CWD}/plain prose, no directives`)).toBe(false);
	});

	it("ignores non-write tools entirely", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			tool_name: "Bash",
			tool_input: { command: "*** Update File: src/a.ts" },
			cwd: CWD,
			timestamp: "2026-07-09T00:00:00Z",
		};
		expect(evaluate(event, reservations, cohort)).toBeNull();
		expect(isLeased(reservations, cohort, `${CWD}/src/a.ts`)).toBe(false);
	});
});
