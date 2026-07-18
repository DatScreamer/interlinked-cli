// Companion tests for read-provenance.ts (LG-3/LG-4).
// Positives prove capture, drift detection, repeat-gating, and blind-span
// location; negatives prove the omp `seenLines === undefined` rule — no
// recorded provenance ⇒ no check fires.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	blindEditSpan,
	ensureEditMechanics,
	fnv1a32,
	recordFileView,
	staleReadWarning,
} from "./read-provenance.js";
import { createFreshSession } from "./session-state-mutators.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

let dir: string;
let target: string;

const CONTENT = ["line one", "line two", "line three", "line four", "line five", ""].join("\n");

function makeEvent(overrides: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "prov-test",
		agent_source: "claude",
		timestamp: new Date().toISOString(),
		cwd: dir,
		...overrides,
	} as HarnessEvent;
}

function makeSession(): SessionTrajectory {
	return createFreshSession(makeEvent({}), "prov-test");
}

function readEvent(extra: Record<string, unknown> = {}): HarnessEvent {
	return makeEvent({
		tool_name: "Read",
		tool_input: { file_path: target, ...extra },
		tool_outcome: "success",
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "read-prov-"));
	target = join(dir, "sample.txt");
	writeFileSync(target, CONTENT);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("recordFileView", () => {
	it("captures a whole-file view on PostToolUse Read", () => {
		const session = makeSession();
		recordFileView(session, readEvent());
		const view = session.file_views?.get(target);
		expect(view).toBeDefined();
		expect(view?.ranges).toBeNull();
		expect(view?.line_hashes[0]).toBe(fnv1a32("line one"));
	});

	it("captures offset/limit reads as displayed ranges and unions them", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 }));
		recordFileView(session, readEvent({ offset: 4, limit: 2 }));
		const view = session.file_views?.get(target);
		expect(view?.ranges).toEqual([
			[1, 2],
			[4, 5],
		]);
	});

	it("does not capture on PreToolUse events or failed writes", () => {
		const session = makeSession();
		recordFileView(
			session,
			makeEvent({ hook_event: "PreToolUse", tool_name: "Read", tool_input: { file_path: target } }),
		);
		recordFileView(
			session,
			makeEvent({
				tool_name: "Edit",
				tool_input: { file_path: target },
				tool_outcome: "error",
			}),
		);
		expect(session.file_views?.get(target)).toBeUndefined();
	});
});

describe("staleReadWarning", () => {
	function viewThenDrift(session: SessionTrajectory): void {
		recordFileView(session, readEvent());
		writeFileSync(target, CONTENT.replace("line three", "line 3 (reformatted)"));
	}

	it("warns once with the divergence line and current content", () => {
		const session = makeSession();
		viewThenDrift(session);
		const warning = staleReadWarning(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line one",
			new_string: "x",
		});
		expect(warning).toMatch(/\[interlinked:stale-read\]\[heuristic\]/);
		expect(warning).toMatch(/Divergence begins at line 3/);
		expect(warning).toContain("line 3 (reformatted)");
	});

	it("repeat-gates per (path, live-hash) so a formatter sweep warns once", () => {
		const session = makeSession();
		viewThenDrift(session);
		const input = { file_path: target, old_string: "line one", new_string: "x" };
		expect(staleReadWarning(session, makeEvent({}), "Edit", input)).not.toBeNull();
		expect(staleReadWarning(session, makeEvent({}), "Edit", input)).toBeNull();
		expect(session.edit_mechanics?.stale_reads).toBe(1);
	});

	it("stays silent without a recorded view, without drift, and for reads", () => {
		const session = makeSession();
		// No view recorded at all:
		expect(
			staleReadWarning(session, makeEvent({}), "Edit", { file_path: target }),
		).toBeNull();
		// View recorded, content unchanged:
		recordFileView(session, readEvent());
		expect(
			staleReadWarning(session, makeEvent({}), "Edit", { file_path: target }),
		).toBeNull();
		// Read tools are never checked:
		writeFileSync(target, "drifted\n");
		expect(
			staleReadWarning(session, makeEvent({}), "Read", { file_path: target }),
		).toBeNull();
	});
});

describe("blindEditSpan", () => {
	it("locates an anchor outside every displayed range", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 })); // saw lines 1–2
		const span = blindEditSpan(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line four",
			new_string: "x",
		});
		expect(span).toEqual({ file: target, startLine: 4, endLine: 4 });
	});

	it("stays silent when the anchor was displayed, on whole-file views, and without provenance", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 3, limit: 3 })); // saw lines 3–5
		expect(
			blindEditSpan(session, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "line four",
				new_string: "x",
			}),
		).toBeNull();
		// Whole-file view ⇒ nothing is blind:
		recordFileView(session, readEvent());
		expect(
			blindEditSpan(session, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "line one",
				new_string: "x",
			}),
		).toBeNull();
		// No view at all (bash-read world) ⇒ fail open:
		const fresh = makeSession();
		expect(
			blindEditSpan(fresh, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "line one",
				new_string: "x",
			}),
		).toBeNull();
	});

	it("skips anchors the doom guard owns (not present in the file)", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 }));
		expect(
			blindEditSpan(session, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "never in the file",
				new_string: "x",
			}),
		).toBeNull();
	});
});

describe("rescue attribution", () => {
	it("counts a successful write to the doomed file within the step window", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		mechanics.doomed = 1;
		mechanics.last_doom = { file: target, step: session.tool_call_count };
		recordFileView(
			session,
			makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
		);
		expect(mechanics.rescued).toBe(1);
		expect(mechanics.last_doom).toBeUndefined();
	});

	it("does not count writes to a different file", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		mechanics.last_doom = { file: join(dir, "other.txt"), step: session.tool_call_count };
		recordFileView(
			session,
			makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
		);
		expect(mechanics.rescued).toBe(0);
	});
});
