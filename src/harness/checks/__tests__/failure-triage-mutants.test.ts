// Mutation-hardening tests for src/harness/checks/failure-triage.ts.
//
// failure-triage.test.ts pins the "obvious" rules (TS2307/2304/2345, ENOENT,
// EACCES, ECONNREFUSED, ETIMEDOUT, SIGSEGV, heap-OOM). This file closes the
// gap surfaced by a mutation-testing sweep (scratch/fleet-r2/kill-briefs/
// src_harness_checks_failure-triage.ts.json): rules that were NEVER exercised
// (TS2322/TS2339/TS6133, EISDIR/ENOTDIR/EEXIST, EAI_AGAIN, 401/403, all four
// npm-specific rules, every git rule, the Test-Suites/assertion rules,
// SIGKILL, user-interrupt), plus boundary-precision cases for `.*` vs `.`,
// `\s+` vs `\s`/`\S+`, `?` optionality, and the buildHaystack composition
// logic (stdout-consultation gating, tool_input.command fallback, the `\n`
// join separator).
//
// Every fixture below was validated against the REAL module (confirming the
// expected output) and then against a shadow-mutated copy of each surviving
// mutant (confirming the mutant's output actually differs) via
// scratch/probes/failure-triage-shadow-verify.mts before being written here.
// Six mutants (rule.tools condition; the error_message/stderr push-condition
// family; `cmd`'s "always push" variant) proved genuinely equivalent under a
// 4000-trial randomized fuzz (scratch/probes/failure-triage-equivalence-fuzz.mts)
// and are documented, not tested, at the bottom of this file.
//
// Labeling: P<n> = must-fire / must-hold; N<n> = must-NOT-fire / boundary guard
// (see src/harness/check-evidence/case-parser.ts for the convention).

import { describe, expect, it } from "vitest";
import type { ToolFailureEvent } from "../../types.js";
import { classifyFailure } from "../failure-triage.js";

function makeEvent(overrides: Partial<ToolFailureEvent> = {}): ToolFailureEvent {
	return {
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Edit",
		timestamp: "2026-05-09T00:00:00Z",
		...overrides,
	};
}

describe("classifyFailure — TS2322 / TS2339 / TS6133 (previously untested rules)", () => {
	it("P1: classifies TS2322 as agent-error/type-mismatch (regex .* boundary: multi-char gaps)", () => {
		const r = classifyFailure(
			makeEvent({
				error_message: "error TS2322: Type 'string' is not assignable to type 'number'.",
			}),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("type-mismatch");
	});

	it("P2: classifies TS2339 as agent-error/missing-property (regex .* boundary: multi-char gaps)", () => {
		const r = classifyFailure(
			makeEvent({
				error_message: "error TS2339: Property 'foo' does not exist on type 'Bar'.",
			}),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("missing-property");
	});

	it("P3: classifies TS6133 as agent-error/unused-declaration (regex .* boundary: multi-char gaps)", () => {
		const r = classifyFailure(
			makeEvent({
				error_message: "error TS6133: 'x' is declared but its value is never read.",
			}),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("unused-declaration");
	});
});

describe("classifyFailure — filesystem-shape rules (EISDIR / ENOTDIR / EEXIST)", () => {
	it("P4: classifies EISDIR as agent-error/filesystem-shape", () => {
		const r = classifyFailure(makeEvent({ error_message: "EISDIR: illegal operation on a directory" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("filesystem-shape");
	});

	it("P5: classifies ENOTDIR as agent-error/filesystem-shape", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "ENOTDIR: not a directory, scandir '/x/y'" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("filesystem-shape");
	});

	it("P6: classifies EEXIST as agent-error/filesystem-shape", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "EEXIST: file already exists, mkdir '/x'" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("filesystem-shape");
	});
});

describe("classifyFailure — EAI_AGAIN + generic ENOTFOUND (previously untested)", () => {
	it("P7: classifies EAI_AGAIN as transient/dns", () => {
		const r = classifyFailure(makeEvent({ error_message: "getaddrinfo EAI_AGAIN example.com" }));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("dns");
	});

	it("P8: classifies bare ENOTFOUND word as agent-error/dns-resolution", () => {
		const r = classifyFailure(makeEvent({ error_message: "Error: ENOTFOUND api.example.com" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("dns-resolution");
	});

	it("P9: classifies 'getaddrinfo ... failed' phrasing as agent-error/dns-resolution (regex .* boundary: multi-char gap, no literal ENOTFOUND word present)", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "getaddrinfo lookup example.com failed" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("dns-resolution");
	});
});

describe("classifyFailure — rate-limit / 401 / 403 (previously untested boundaries)", () => {
	it("P10: classifies 'ratelimit' (no space) as transient/rate-limit (regex `rate ?limit` optional-space boundary)", () => {
		const r = classifyFailure(makeEvent({ error_message: "hit ratelimit while calling API" }));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("rate-limit");
	});

	it("P11: classifies HTTP 401 unauthorized as agent-error/auth (regex .* boundary: multi-char gap)", () => {
		const r = classifyFailure(makeEvent({ error_message: "HTTP 401: unauthorized access" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("auth");
	});

	it("P12: classifies HTTP 403 forbidden as agent-error/auth (regex .* boundary: multi-char gap)", () => {
		const r = classifyFailure(makeEvent({ error_message: "HTTP 403: Forbidden - access denied" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("auth");
	});
});

describe("classifyFailure — npm-specific rules (previously untested; \\s+ vs \\s/\\S+ boundaries)", () => {
	it("P13: classifies npm E429 with irregular (double) spacing as transient/rate-limit (\\s+ boundary: 2+ spaces at every gap)", () => {
		const r = classifyFailure(
			makeEvent({ tool_name: "Bash", stderr: "npm  ERR!  code  E429" }),
		);
		expect(r.label).toBe("transient");
		expect(r.category).toBe("rate-limit");
	});

	it("P14: classifies npm ENOTFOUND (double-spaced, glued suffix) as agent-error/dns-resolution via the NPM-SPECIFIC rule, not the shadowing generic ENOTFOUND rule", () => {
		// "ENOTFOUNDX" (word char glued directly after ENOTFOUND) breaks the
		// generic rule's trailing \bENOTFOUND\b boundary, so only the
		// npm-specific regex (no trailing \b) can match this — proving the
		// npm-specific rule is reachable and pinning which one fired.
		const r = classifyFailure(
			makeEvent({ tool_name: "Bash", tool_input: { command: "npm  ERR!  code  ENOTFOUNDX" } }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("dns-resolution");
		expect(r.matched_rule).toBe("npm\\s+ERR!\\s+code\\s+ENOTFOUND");
	});

	it("P15: classifies npm ENOTFOUND (single-spaced, glued suffix) as agent-error/dns-resolution via the NPM-SPECIFIC rule (\\S+ boundary: real gaps are whitespace)", () => {
		const r = classifyFailure(
			makeEvent({ tool_name: "Bash", tool_input: { command: "npm ERR! code ENOTFOUNDX" } }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("dns-resolution");
		expect(r.matched_rule).toBe("npm\\s+ERR!\\s+code\\s+ENOTFOUND");
	});

	it("P16: classifies npm 404 (double-spaced) as agent-error/missing-package", () => {
		const r = classifyFailure(
			makeEvent({ tool_name: "Bash", stderr: "npm  ERR!  404 Not Found" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("missing-package");
	});

	it("P17: classifies npm 'Cannot find module' (double-spaced) as agent-error/missing-package", () => {
		const r = classifyFailure(
			makeEvent({ tool_name: "Bash", stderr: "npm  ERR!  Cannot find module" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("missing-package");
	});

	it("P18: classifies npm ELIFECYCLE (double-spaced) as agent-error/package-script", () => {
		const r = classifyFailure(
			makeEvent({ tool_name: "Bash", stderr: "npm  ERR!  code  ELIFECYCLE" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("package-script");
	});
});

describe("classifyFailure — git rules (previously untested)", () => {
	it("P19: classifies 'not a git repository' as environmental/git-state (regex .* boundary: needs an EARLIER standalone 'git' word)", () => {
		const r = classifyFailure(
			makeEvent({
				error_message: "git status: not a git repository (or any of the parent directories)",
			}),
		);
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("git-state");
	});

	it("P20: classifies 'merge conflict' as agent-error/git-conflict", () => {
		const r = classifyFailure(makeEvent({ error_message: "merge conflict detected in file.ts" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("git-conflict");
	});

	it("P21: classifies 'pre-commit hook ... failed' as agent-error/pre-commit (regex .* boundary, 1st OR-alternative)", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "Error: pre-commit hook eslint-check failed" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("pre-commit");
	});

	it("P22: classifies 'husky ... failed' as agent-error/pre-commit (regex .* boundary, 2nd OR-alternative, no 'pre-commit hook' text present)", () => {
		const r = classifyFailure(makeEvent({ error_message: "husky commit-msg failed" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("pre-commit");
	});

	it("P23: classifies 'CONFLICT (content)' as agent-error/git-conflict, isolated from the earlier merge-conflict rule (no 'conflict in'/'merge conflict' text present)", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "CONFLICT (content): needs manual resolution" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("git-conflict");
	});
});

describe("classifyFailure — Test Suites regex boundaries (previously untested; 10 mutated variants)", () => {
	it("P24: classifies a two-digit failure count with no leading whitespace as agent-error/test-failure", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "Test Suites: 12 failed, 3 passed, 15 total" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("test-failure");
	});

	it("P25: classifies leading-whitespace-indented output as agent-error/test-failure (\\s* boundary: leading spaces present)", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "  Test Suites: 4 failed, 2 passed, 6 total" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("test-failure");
	});

	it("P26: classifies double-space after the colon as agent-error/test-failure (middle \\s+ boundary)", () => {
		const r = classifyFailure(makeEvent({ error_message: "Test Suites:  15 failed, 2 passed" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("test-failure");
	});

	it("P27: classifies 'TestSuites' with no space as agent-error/test-failure (optional-space-after-Test boundary)", () => {
		const r = classifyFailure(makeEvent({ error_message: "TestSuites: 5 failed, 1 passed" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("test-failure");
	});

	it("P28: classifies singular 'Test Suite' (no trailing s) as agent-error/test-failure (optional-trailing-s-on-Suite boundary)", () => {
		const r = classifyFailure(makeEvent({ error_message: "Test Suite: 1 failed, 0 passed" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("test-failure");
	});

	it("P29: classifies bare 'Test:' (no Suite word, no trailing s) as agent-error/test-failure (optional-trailing-s-on-Tests boundary)", () => {
		const r = classifyFailure(makeEvent({ error_message: "Test: 3 failed, 1 passed" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("test-failure");
	});

	it("N1: does NOT classify 'Test Suites: N failed' as test-failure when it is not at a line start (^ with /m boundary)", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "Ran suite; Test Suites: 2 failed unexpectedly" }),
		);
		expect(r.label).not.toBe("agent-error");
		expect(r.category).not.toBe("test-failure");
	});
});

describe("classifyFailure — AssertionError / Expected-to-but / SIGKILL / user-interrupt (previously untested)", () => {
	it("P30: classifies bare 'AssertionError' as agent-error/assertion", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "AssertionError: expected true to equal false" }),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("assertion");
	});

	it("P31: classifies 'Expected ... to ...' phrasing as agent-error/assertion (regex .* boundary: multi-char gap)", () => {
		const r = classifyFailure(makeEvent({ error_message: "Expected value 'foo' to equal 'bar'" }));
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("assertion");
	});

	it("P32: classifies SIGKILL as unrecoverable/process-killed", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "Process terminated: SIGKILL received" }),
		);
		expect(r.label).toBe("unrecoverable");
		expect(r.category).toBe("process-killed");
	});

	it("P33: classifies American-spelling 'canceled' (single L) as transient/user-interrupt (cancell?ed optional-L boundary)", () => {
		const r = classifyFailure(makeEvent({ error_message: "user canceled the operation" }));
		expect(r.label).toBe("transient");
		expect(r.category).toBe("user-interrupt");
	});
});

describe("buildHaystack (via classifyFailure) — stdout consultation gating", () => {
	it("P34: classifies via stdout for tool_name='Bash' when stderr is absent", () => {
		const r = classifyFailure(
			makeEvent({ tool_name: "Bash", stdout: "ENOENT: no such file, open '/x'" }),
		);
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("filesystem-missing");
	});

	it("P35: classifies via stdout for tool_name='Shell' when stderr is absent (BASH_LIKE_TOOLS membership)", () => {
		const r = classifyFailure(makeEvent({ tool_name: "Shell", stdout: "ENOENT: no such file" }));
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("filesystem-missing");
	});

	it("P36: classifies via stdout for tool_name='shell' (lowercase) when stderr is absent (BASH_LIKE_TOOLS membership)", () => {
		const r = classifyFailure(makeEvent({ tool_name: "shell", stdout: "ENOENT: no such file" }));
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("filesystem-missing");
	});

	it("P37: classifies via stdout for tool_name='run_command' when stderr is absent (BASH_LIKE_TOOLS membership)", () => {
		const r = classifyFailure(
			makeEvent({ tool_name: "run_command", stdout: "ENOENT: no such file" }),
		);
		expect(r.label).toBe("environmental");
		expect(r.category).toBe("filesystem-missing");
	});

	it("N2: does NOT consult stdout for a non-bash-like tool_name, even when stdout alone carries a real diagnostic", () => {
		const r = classifyFailure(makeEvent({ tool_name: "Edit", stdout: "ENOENT: no such file" }));
		expect(r.label).toBe("unknown");
		expect(r.category).toBe("no-diagnostic");
	});

	it("N3: does NOT consult stdout when stderr is ALSO present, even for a bash-like tool (stdout is noise once stderr exists)", () => {
		const r = classifyFailure(
			makeEvent({
				tool_name: "Bash",
				stderr: "some entirely novel diagnostic that no rule handles",
				stdout: "ENOENT: no such file, open '/x'",
			}),
		);
		expect(r.label).toBe("unknown");
		expect(r.category).toBe("uncategorized");
	});
});

describe("buildHaystack (via classifyFailure) — tool_input.command fallback + join separator", () => {
	it("P38: classifies via tool_input.command alone when no other diagnostic field is set", () => {
		const r = classifyFailure(
			makeEvent({
				tool_name: "Bash",
				tool_input: { command: "npm ERR! code E429 too many requests" },
			}),
		);
		expect(r.label).toBe("transient");
		expect(r.category).toBe("rate-limit");
	});

	it("N4: does NOT stringify a non-string tool_input.command into the haystack (typeof-string guard)", () => {
		// tool_input is a JsonObject ({[key: string]: unknown}), so a numeric
		// "command" is structurally valid — this probes the runtime typeof
		// guard, not a type error.
		const r = classifyFailure(
			makeEvent({
				tool_name: "Bash",
				tool_input: { command: 429 },
			}),
		);
		expect(r.label).toBe("unknown");
		expect(r.category).toBe("no-diagnostic");
	});

	it("P39: joins error_message and stderr with a real newline, so a line-start-anchored rule on the SECOND part still fires (join separator)", () => {
		const r = classifyFailure(
			makeEvent({
				error_message: "build step output",
				stderr: "Test Suites: 2 failed, 1 passed",
			}),
		);
		expect(r.label).toBe("agent-error");
		expect(r.category).toBe("test-failure");
	});
});

describe("classifyFailure — source field pinned across all three return branches", () => {
	it("P40: source is 'local-heuristic' on the no-diagnostic branch (empty event)", () => {
		const r = classifyFailure(makeEvent({}));
		expect(r.source).toBe("local-heuristic");
		expect(r.label).toBe("unknown");
		expect(r.category).toBe("no-diagnostic");
	});

	it("P41: source is 'local-heuristic' on a matched-rule branch", () => {
		const r = classifyFailure(makeEvent({ error_message: "ENOENT: no such file" }));
		expect(r.source).toBe("local-heuristic");
	});

	it("P42: source is 'local-heuristic' on the uncategorized (unmatched, non-empty haystack) branch", () => {
		const r = classifyFailure(
			makeEvent({ error_message: "some entirely novel diagnostic that no rule handles" }),
		);
		expect(r.source).toBe("local-heuristic");
		expect(r.label).toBe("unknown");
		expect(r.category).toBe("uncategorized");
	});
});

// ---------------------------------------------------------------------------
// Genuinely equivalent mutants (deliberately not tested here) — proven via a
// 4000-trial randomized fuzz over both real and shadow-mutated copies
// (scratch/probes/failure-triage-equivalence-fuzz.mts, zero divergence for
// every trial), on top of the structural reasoning below:
//
//  - classifyFailure's `rule.tools && !rule.tools.includes(event.tool_name)`
//    forced to `false`: every one of the 34 built-in TRIAGE_RULES entries
//    leaves `tools` unset, so the real expression is `undefined && ...`
//    (always falsy) for every reachable input — identical to a hardcoded
//    `false`. (Confirmed: `listTriageRules().filter(r => r.tools !== undefined).length === 0`.)
//  - buildHaystack's `if (event.error_message) parts.push(...)` and
//    `if (event.stderr && event.stderr !== event.error_message) parts.push(...)`
//    forced to always-true (plus the `&&`->`||` and sub-condition variants of
//    the second): a string is only JS-falsy when it is exactly `""`, and
//    `Array.prototype.join` renders both `undefined` and `""` array elements
//    as empty. Forcing these pushes can therefore only ever inject an empty
//    element or a byte-for-byte DUPLICATE of text already present elsewhere
//    in the haystack — never new characters. `Array.prototype.join("\n")`
//    always inserts a literal `\n` between elements (never merges two
//    adjacent parts into one token), and none of the 34 rule regexes uses
//    the `/s` (dotAll) flag or a `$`/exact-length anchor, so no amount of
//    extra blank segments or duplicated substrings can flip a `.test()`
//    result. The one anchor that IS position-sensitive (`^...failed`) uses
//    `/m`, so an injected leading `\n` only ever creates ANOTHER valid match
//    position — it can never destroy the real one.
//  - buildHaystack's `if (cmd) parts.push(cmd)` condition forced to always
//    `true`: `cmd` is only falsy when it is exactly `""` (the ternary's
//    false-branch literal), so forcing the push injects nothing but an
//    empty/no-op element, by the same join-invariance argument above.
// ---------------------------------------------------------------------------
