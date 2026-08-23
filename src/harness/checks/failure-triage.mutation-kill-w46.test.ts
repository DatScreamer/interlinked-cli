import { describe, expect, it } from "vitest";
import { classifyFailure } from "./failure-triage.js";
import type { ToolFailureEvent } from "../types.js";

function ev(partial: Partial<ToolFailureEvent> & { tool_name?: string } = {}): ToolFailureEvent {
	return {
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Bash",
		timestamp: "2026-08-23T00:00:00Z",
		...partial,
	};
}

describe("classifyFailure — positive (must fire)", () => {
	it("P1: no diagnostic at all returns no-diagnostic + local-heuristic source", () => {
		const r = classifyFailure(ev());
		expect(r.category).toBe("no-diagnostic");
		expect(r.label).toBe("unknown");
		expect(r.confidence).toBe(0);
		expect(r.source).toBe("local-heuristic");
	});

	it("P2: unmatched but present haystack returns uncategorized + local-heuristic source", () => {
		const r = classifyFailure(ev({ error_message: "some unrelated benign text" }));
		expect(r.category).toBe("uncategorized");
		expect(r.label).toBe("unknown");
		expect(r.confidence).toBe(0.2);
		expect(r.source).toBe("local-heuristic");
	});

	it("P3: matched rule sets local-heuristic source", () => {
		const r = classifyFailure(ev({ error_message: "EEXIST: file already exists, mkdir '/foo'" }));
		expect(r.source).toBe("local-heuristic");
	});

	it("P4: TS2322 with wide gaps around wildcards matches type-mismatch/agent-error", () => {
		const r = classifyFailure(
			ev({ error_message: "error TS2322: Type 'string' is not assignable to type 'number'" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("type-mismatch");
	});

	it("P5: TS2339 with wide gaps around wildcards matches missing-property/agent-error", () => {
		const r = classifyFailure(
			ev({ error_message: "error TS2339: Property 'foo' does not exist on type 'Bar'" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("missing-property");
	});

	it("P6: TS6133 with wide gaps around wildcards matches unused-declaration/agent-error", () => {
		const r = classifyFailure(
			ev({ error_message: "error TS6133: 'foo' is declared but its value is never read" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("unused-declaration");
	});

	it("P7: EISDIR matches filesystem-shape/agent-error", () => {
		const r = classifyFailure(ev({ error_message: "EISDIR: illegal operation on a directory" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("filesystem-shape");
	});

	it("P8: ENOTDIR matches filesystem-shape/agent-error", () => {
		const r = classifyFailure(ev({ error_message: "ENOTDIR: not a directory, scandir '/foo'" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("filesystem-shape");
	});

	it("P9: EEXIST matches filesystem-shape/agent-error", () => {
		const r = classifyFailure(ev({ error_message: "EEXIST: file already exists, mkdir '/foo'" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("filesystem-shape");
	});

	it("P10: EAI_AGAIN matches dns/transient", () => {
		const r = classifyFailure(ev({ error_message: "DNS lookup failed: EAI_AGAIN" }));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("dns");
	});

	it("P11: getaddrinfo with a wide gap before 'failed' matches dns-resolution/agent-error", () => {
		const r = classifyFailure(ev({ error_message: "getaddrinfo ENODATA example.com failed" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("dns-resolution");
	});

	it("P12: 'ratelimit' (no space, exercises optional-space quantifier) matches rate-limit/transient", () => {
		const r = classifyFailure(ev({ error_message: "Error: ratelimit exceeded" }));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("rate-limit");
	});

	it("P13: 401 with a wide gap before 'unauthor' matches auth/agent-error", () => {
		const r = classifyFailure(
			ev({ error_message: "Request failed with 401 - unauthorized user" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("auth");
	});

	it("P14: 403 with a wide gap before 'forbidden' matches auth/agent-error", () => {
		const r = classifyFailure(ev({ error_message: "Request failed: 403 - forbidden resource" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("auth");
	});

	it("P15: npm E429 with exaggerated whitespace still matches rate-limit/transient", () => {
		const r = classifyFailure(ev({ error_message: "npm  ERR!   code   E429" }));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("rate-limit");
	});

	it("P16: npm ENOTFOUND with exaggerated whitespace still matches dns-resolution/agent-error", () => {
		const r = classifyFailure(ev({ error_message: "npm  ERR!  code  ENOTFOUND" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("dns-resolution");
	});

	it("P17: haystack built from stdout-only for a Bash-like tool with no stderr", () => {
		const r = classifyFailure(
			ev({ tool_name: "Bash", stdout: "ENOENT: no such file", stderr: undefined }),
		);
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("filesystem-missing");
	});

	it("P18: tool_input.command with a matching npm rate-limit body is used as fallback diagnostic", () => {
		const r = classifyFailure(
			ev({ tool_input: { command: "npm ERR! code E429 too many requests" } }),
		);
		expect(r.label).toBe("transient");
		expect(r.category).toBe("rate-limit");
	});

	it("P19: haystack join uses newline separator (Tests-failed pattern needs a fresh line start)", () => {
		const r = classifyFailure(ev({ error_message: "xyz", stderr: "Tests: 3 failed" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("test-failure");
	});
});

describe("classifyFailure — negative / boundary (must not fire the same as the wide-gap positive)", () => {
	it("N1: stdout is ignored for a non-Bash-like tool even with no stderr", () => {
		const r = classifyFailure(
			ev({ tool_name: "Read", stdout: "ENOENT: no such file", stderr: undefined }),
		);
		expect(r.category).toBe("no-diagnostic");
	});

	it("N2: stdout is ignored when stderr is present (even truthy stdout)", () => {
		const r = classifyFailure(
			ev({ tool_name: "Bash", stdout: "ENOENT: no such file", stderr: "unrelated stderr text" }),
		);
		expect(r.category).not.toBe("filesystem-missing");
	});

	it("N3: tool_input.command with a non-string command value is not used as diagnostic text", () => {
		// SAFETY: deliberately mistyped to exercise the runtime typeof-guard in buildHaystack.
		const r = classifyFailure(
			ev({ tool_input: { command: 123 as unknown as string } }),
		);
		expect(r.category).toBe("no-diagnostic");
	});

	it("N4: tool_input.command that is falsy-empty produces no-diagnostic", () => {
		const r = classifyFailure(ev({ tool_input: {} }));
		expect(r.category).toBe("no-diagnostic");
	});
});
