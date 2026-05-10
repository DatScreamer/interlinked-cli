// Phase 1 Channel 3 — recovery-suggestion tests.
// Pin the template substitution + fallback-by-label behavior so refactors
// of the registry don't silently regress the agent-facing fix language.

import { describe, expect, it } from "vitest";

import {
	listRecoveryKeys,
	suggestRecovery,
} from "../recovery-suggestion.js";
import type { ToolFailureEvent, TriageResult } from "../../types.js";

function makeEvent(overrides: Partial<ToolFailureEvent> = {}): ToolFailureEvent {
	return {
		session_id: "s",
		agent_source: "claude",
		tool_name: "Edit",
		timestamp: "2026-05-09T00:00:00Z",
		...overrides,
	};
}

const triage = (label: TriageResult["label"], category: string): TriageResult => ({
	label,
	category,
	confidence: 0.85,
	source: "local-heuristic",
});

describe("suggestRecovery — module-name extraction", () => {
	it("substitutes the missing module into the template", () => {
		const r = suggestRecovery(
			makeEvent({ error_message: "Cannot find module './missing'" }),
			triage("agent-error", "missing-import"),
		);
		expect(r).toContain("./missing");
		expect(r).toMatch(/import \{/);
	});
	it("emits the template even without an extractable module name", () => {
		const r = suggestRecovery(
			makeEvent({ error_message: "Cannot find module" }),
			triage("agent-error", "missing-import"),
		);
		expect(r).toContain("<module>");
	});
});

describe("suggestRecovery — type-mismatch", () => {
	it("emits the type-mismatch template", () => {
		const r = suggestRecovery(
			makeEvent({ error_message: "Argument of type 'string' is not assignable" }),
			triage("agent-error", "type-mismatch"),
		);
		expect(r).toMatch(/argument type/i);
	});
});

describe("suggestRecovery — environmental", () => {
	it("returns filesystem-missing template for ENOENT", () => {
		const r = suggestRecovery(
			makeEvent({ error_message: "ENOENT" }),
			triage("environmental", "filesystem-missing"),
		);
		expect(r).toMatch(/path is correct/i);
	});
});

describe("suggestRecovery — fallback path", () => {
	it("falls back to label fallback when category is unknown", () => {
		const r = suggestRecovery(
			makeEvent({ error_message: "novel error" }),
			triage("agent-error", "totally-new-category"),
		);
		expect(r).not.toBeNull();
		expect(r).toMatch(/agent-side mistake/i);
	});
	it("returns null for unknown label with no fallback", () => {
		const r = suggestRecovery(
			makeEvent({}),
			triage("unknown", "no-diagnostic"),
		);
		expect(r).toBeNull();
	});
});

describe("listRecoveryKeys — registry stability", () => {
	it("exposes a non-empty registry", () => {
		expect(listRecoveryKeys().length).toBeGreaterThan(15);
	});
	it("includes the canonical core keys", () => {
		const keys = new Set(listRecoveryKeys());
		expect(keys.has("agent-error/missing-import")).toBe(true);
		expect(keys.has("transient/rate-limit")).toBe(true);
		expect(keys.has("environmental/filesystem-missing")).toBe(true);
	});
});
