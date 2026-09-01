import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderProviderBridgePrelude } from "./provider-bridge-source.js";

interface BridgeDecision {
	decision: "allow" | "block" | "ask";
	reason?: string;
	additional_context?: string;
}

function generatedResponseNormalizer(): (text: string) => BridgeDecision {
	const source = renderProviderBridgePrelude("pi", "/tmp/hook-entry.mjs");
	const start = source.indexOf("function interlinkedDecisionFromOutput");
	const end = source.indexOf("\nfunction invokeInterlinked", start);
	if (start < 0 || end < 0) throw new Error("generated response normalizer is missing");
	const sandbox: { interlinkedDecisionFromOutput?: (text: string) => BridgeDecision } = {};
	runInNewContext(source.slice(start, end), sandbox);
	if (!sandbox.interlinkedDecisionFromOutput) {
		throw new Error("generated response normalizer did not initialize");
	}
	return sandbox.interlinkedDecisionFromOutput;
}

describe("generated provider bridge response compatibility", () => {
	const normalize = generatedResponseNormalizer();

	it("treats a successful legacy hook with empty stdout as allow", () => {
		expect(normalize("")).toEqual({ decision: "allow" });
	});

	it("preserves the current provider-neutral decision envelope", () => {
		expect(normalize('{"decision":"ask","reason":"confirm"}')).toEqual({
			decision: "ask",
			reason: "confirm",
		});
	});

	it("maps legacy Claude PreToolUse permission decisions", () => {
		expect(
			normalize(
				'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"unsafe"}}',
			),
		).toEqual({ decision: "block", reason: "unsafe" });
		expect(
			normalize(
				'{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"confirm"}}',
			),
		).toEqual({ decision: "ask", reason: "confirm" });
	});

	it("maps legacy Claude PermissionRequest and model context shapes", () => {
		expect(
			normalize(
				'{"hookSpecificOutput":{"decision":{"behavior":"deny","message":"policy"}}}',
			),
		).toEqual({ decision: "block", reason: "policy" });
		expect(
			normalize('{"hookSpecificOutput":{"additionalContext":"review complete"}}'),
		).toEqual({ decision: "allow", additional_context: "review complete" });
	});
});
