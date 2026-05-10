// ===========================================
// session-state — files_written provenance + path normalization
// ===========================================
// Pin Channel 5's provenance contract:
//   - failed Edit attempts (tool_outcome === "error") must NOT land in
//     files_written (otherwise we'd offer to roll back the user's own
//     unrelated changes)
//   - successful writes land in BOTH the raw form (preserves existing
//     callers like structural-checks.ts:340 that compare against rawpath)
//     AND the resolved absolute form (lets the new isFileTrackedAsWritten
//     helper match regardless of input shape)

import { describe, expect, it } from "vitest";
import { resolve as resolvePath } from "node:path";

import { isFileTrackedAsWritten, SessionTracker } from "../session-state.js";
import type { HarnessEvent } from "../types.js";

const cwd = "/repo";

const baseWrite = (overrides: Partial<HarnessEvent>): HarnessEvent => ({
	hook_event: "PostToolUse",
	session_id: "prov-session",
	agent_name: "alice",
	agent_source: "claude",
	tool_name: "Edit",
	tool_input: { file_path: "src/foo.ts" },
	cwd,
	timestamp: "2026-05-09T10:00:00Z",
	...overrides,
});

describe("files_written — outcome-aware tracking", () => {
	it("records successful writes", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseWrite({ tool_outcome: "success" }));
		const session = tracker.get("prov-session");
		expect(session?.files_written.has("src/foo.ts")).toBe(true);
	});

	it("records writes with no outcome field (legacy default)", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseWrite({}));
		const session = tracker.get("prov-session");
		expect(session?.files_written.has("src/foo.ts")).toBe(true);
	});

	it("rejects failed writes (tool_outcome:error)", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseWrite({ tool_outcome: "error" }));
		const session = tracker.get("prov-session");
		expect(session?.files_written.has("src/foo.ts")).toBe(false);
	});

	it("rejects interrupted writes", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseWrite({ tool_outcome: "interrupted" }));
		const session = tracker.get("prov-session");
		expect(session?.files_written.has("src/foo.ts")).toBe(false);
	});
});

describe("files_written — path normalization", () => {
	it("stores both raw and absolute forms for relative paths", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseWrite({ tool_outcome: "success" }));
		const session = tracker.get("prov-session");
		const absExpected = resolvePath(cwd, "src/foo.ts");
		expect(session?.files_written.has("src/foo.ts")).toBe(true);
		expect(session?.files_written.has(absExpected)).toBe(true);
	});

	it("stores absolute path once when input is already absolute", () => {
		const tracker = new SessionTracker();
		const abs = "/repo/src/already-abs.ts";
		tracker.recordEvent(baseWrite({ tool_input: { file_path: abs }, tool_outcome: "success" }));
		const session = tracker.get("prov-session");
		expect(session?.files_written.has(abs)).toBe(true);
		// Set semantics — adding the same absolute path twice is a no-op
		expect(
			[...(session?.files_written ?? new Set())].filter((p) => p === abs).length,
		).toBe(1);
	});
});

describe("isFileTrackedAsWritten — shape-agnostic lookup", () => {
	it("matches by raw form", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseWrite({ tool_outcome: "success" }));
		const session = tracker.get("prov-session");
		expect(isFileTrackedAsWritten(session!, "src/foo.ts", cwd)).toBe(true);
	});

	it("matches by absolute form", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseWrite({ tool_outcome: "success" }));
		const session = tracker.get("prov-session");
		const abs = resolvePath(cwd, "src/foo.ts");
		expect(isFileTrackedAsWritten(session!, abs, cwd)).toBe(true);
	});

	it("returns false for paths not in files_written", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseWrite({ tool_outcome: "success" }));
		const session = tracker.get("prov-session");
		expect(isFileTrackedAsWritten(session!, "src/other.ts", cwd)).toBe(false);
	});

	it("returns false for failed-write paths (provenance gate)", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseWrite({ tool_outcome: "error" }));
		const session = tracker.get("prov-session");
		expect(isFileTrackedAsWritten(session!, "src/foo.ts", cwd)).toBe(false);
	});
});
