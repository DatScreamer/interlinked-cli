import { describe, expect, it } from "vitest";
import type { RecurrenceEvent } from "./recurrence.js";
import {
	deriveSignature,
	SIGNATURE_ASSEMBLY_CAP,
	signaturePayload,
} from "./recurrence-signature.js";

function ev(overrides: Partial<RecurrenceEvent> = {}): RecurrenceEvent {
	return { ts: "2026-05-01T00:00:00.000Z", kind: "harness_missed", ...overrides };
}

describe("deriveSignature", () => {
	it("namespaces every kind with its own prefix", () => {
		expect(deriveSignature(ev({ kind: "harness_caught", check_id: "c", agent_source: "a" }))).toBe(
			"harness_caught:c:a",
		);
		expect(deriveSignature(ev({ kind: "codebase_existing", check_id: "c" }))).toBe(
			"codebase_existing:c",
		);
		expect(deriveSignature(ev({ kind: "harness_missed", signature: "raw-sql" }))).toBe(
			"harness_missed:raw-sql",
		);
	});

	it("groups outcome_marker by fire identity, not free text (round-12 #2 / round-13 sol #1)", () => {
		const fire = { file: "a.ts", session_id: "s1", fire_ts: "2026-01-01T00:00:00Z" };
		// Different fires (distinct check_id) must NOT collapse into one row.
		const a = deriveSignature(ev({ kind: "outcome_marker", check_id: "a", ...fire }));
		const b = deriveSignature(ev({ kind: "outcome_marker", check_id: "b", ...fire }));
		expect(a).not.toBe(b);
		expect(a.startsWith("outcome_marker:")).toBe(true);
		// The SAME fire keys identically regardless of message wording.
		const c1 = deriveSignature(ev({ kind: "outcome_marker", check_id: "a", ...fire, message: "one" }));
		const c2 = deriveSignature(ev({ kind: "outcome_marker", check_id: "a", ...fire, message: "two" }));
		expect(c1).toBe(c2);
		// Still a distinct namespace from harness_missed.
		expect(deriveSignature(ev({ kind: "outcome_marker" }))).not.toBe(
			deriveSignature(ev({ kind: "harness_missed" })),
		);
	});

	it("tool_failure forwards a prebuilt signature, else a coarse fallback", () => {
		expect(deriveSignature(ev({ kind: "tool_failure", signature: "tool_failure:x:y:z" }))).toBe(
			"tool_failure:x:y:z",
		);
		expect(deriveSignature(ev({ kind: "tool_failure", check_id: "bash", message: "boom" }))).toBe(
			"tool_failure:bash:boom",
		);
	});

	it("enforces the tool_failure: namespace on a forwarded signature (round-15 sol #3)", () => {
		// A caller-supplied signature that looks like another kind's key must be
		// namespaced so it cannot impersonate it.
		expect(deriveSignature(ev({ kind: "tool_failure", signature: "harness_missed:x" }))).toBe(
			"tool_failure:harness_missed:x",
		);
	});

	it("disambiguates long signatureless failure messages by hash (round-18 sol #2)", () => {
		const shared = "0".repeat(130); // longer than the 120-char readable cap
		const a = deriveSignature(ev({ kind: "tool_failure", check_id: "bash", message: `${shared} error A` }));
		const b = deriveSignature(ev({ kind: "tool_failure", check_id: "bash", message: `${shared} error B` }));
		// Same 120-char prefix, distinct full messages → must NOT collapse.
		expect(a).not.toBe(b);
		// A short message stays fully readable (no hash suffix).
		expect(deriveSignature(ev({ kind: "tool_failure", check_id: "bash", message: "boom" }))).toBe(
			"tool_failure:bash:boom",
		);
	});

	it("falls back to message then 'untagged' for signatureless kinds", () => {
		expect(deriveSignature(ev({ kind: "harness_missed", message: "m" }))).toBe(
			"harness_missed:m",
		);
		expect(deriveSignature(ev({ kind: "harness_missed" }))).toBe("harness_missed:untagged");
	});
});

describe("signaturePayload", () => {
	it("strips the leading <kind>: transport prefix", () => {
		expect(signaturePayload("harness_missed:the-payload")).toBe("the-payload");
		expect(signaturePayload("harness_caught:check:agent")).toBe("check:agent");
	});

	it("returns the whole string when there is no colon", () => {
		expect(signaturePayload("nocolon")).toBe("nocolon");
	});
});

describe("SIGNATURE_ASSEMBLY_CAP", () => {
	it("is a positive finite bound", () => {
		expect(Number.isInteger(SIGNATURE_ASSEMBLY_CAP)).toBe(true);
		expect(SIGNATURE_ASSEMBLY_CAP).toBeGreaterThan(0);
	});
});
