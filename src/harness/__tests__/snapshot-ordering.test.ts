// Regression test for the "snapshot written before post-event mutations"
// bug flagged in the Plan 08 review.
//
// Background: the live-snapshot durability path used to write the snapshot
// immediately after `sessions.recordEvent(event)` inside `processEvent`. But
// PostToolUse handlers and SkillEnter handlers mutate session state AFTER
// `recordEvent` — `tdd_cycles`, `assertion_counts`, `active_skills`, etc.
// On a daemon restart between two events those post-event mutations were
// lost even though the snapshot durability path was meant to preserve them.
//
// The fix moved the snapshot write to a try/finally in `evaluateEventLine`,
// so it fires AFTER `processEvent` returns (or throws). This test enforces
// that ordering by reading the source — running the actual daemon to check
// timing would be heavy and flaky compared to a structural assertion.
//
// NOTE: `processEvent` / `evaluateEventLine` were extracted from `server.ts`
// into the `createEventLoop` factory in `server-event-loop.ts` during the
// per-file line-cap decomposition — this test reads them from their new home.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EVENT_LOOP_TS = readFileSync(
	join(process.cwd(), "src", "harness", "server-event-loop.ts"),
	"utf-8",
);

describe("processEvent snapshot ordering (Plan 08 review fix)", () => {
	it("does NOT write the snapshot directly after recordEvent in processEvent", () => {
		// The bug shape: `sessions.recordEvent(event)` followed within ~10
		// lines by `writeLiveSnapshot(CWD, ...)`. Sliding-window check on
		// the source. If a future refactor reintroduces the early write,
		// this assertion catches it.
		const recordIdx = EVENT_LOOP_TS.indexOf("sessions.recordEvent(event);");
		expect(recordIdx).toBeGreaterThan(0);

		// Window: 600 chars after recordEvent — comfortably past any plausible
		// "early durability" placement.
		const window = EVENT_LOOP_TS.slice(recordIdx, recordIdx + 600);
		expect(window).not.toContain("writeLiveSnapshot");
	});

	it("writes the snapshot inside evaluateEventLine's finally block", () => {
		// Confirm the new home of the durability write — finally clause of
		// evaluateEventLine. We assert both the function name AND a finally
		// block AND the write call appear in order, so a partial refactor
		// can't slip past.
		const fnIdx = EVENT_LOOP_TS.indexOf("async function evaluateEventLine(");
		expect(fnIdx).toBeGreaterThan(0);

		const fnSlice = EVENT_LOOP_TS.slice(fnIdx, fnIdx + 4000);
		const finallyIdx = fnSlice.indexOf("} finally {");
		const writeIdx = fnSlice.indexOf("writeLiveSnapshot(CWD, sessionIdForSnap, snap)");

		expect(finallyIdx).toBeGreaterThan(0);
		expect(writeIdx).toBeGreaterThan(finallyIdx);
	});

	it("captures session_id before the try/finally so the finally has it on throw", () => {
		// If a future refactor moves session_id parsing inside the try, an
		// exception in processEvent leaves the finally with no session id and
		// silently skips the snapshot. Lock the ordering.
		const fnIdx = EVENT_LOOP_TS.indexOf("async function evaluateEventLine(");
		const fnSlice = EVENT_LOOP_TS.slice(fnIdx, fnIdx + 4000);
		const sessionIdAssignIdx = fnSlice.indexOf("sessionIdForSnap = parsed.session_id");
		// The processEvent call sits inside the try that the finally guards; assert
		// the session_id was captured before it (indentation-agnostic substring).
		const processEventCallIdx = fnSlice.indexOf("const decision = await processEvent(line)");

		expect(sessionIdAssignIdx).toBeGreaterThan(0);
		expect(processEventCallIdx).toBeGreaterThan(sessionIdAssignIdx);
	});
});
