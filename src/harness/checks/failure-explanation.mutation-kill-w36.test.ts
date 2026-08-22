// Wave 36 mutation-kill suite for failure-explanation.ts.
// Kills the surviving StringLiteral mutants inside each template body (every
// mutant flattens one concatenated string fragment to "") plus the
// module-level FALLBACK_BY_LABEL["agent-error"] string. Each assertion below
// checks the FULL exact output string, so any single fragment being wiped
// out changes the assertion — no partial-match survivor gap.
//
// A separate cluster of survivors in `buildContext` (the ctx.file
// extraction branch, the ctx.error "" defaults, the `if (tmpl)` /
// `if (errorText)` truthiness checks, and one Regex trailing-class mutant)
// produce NO observable difference through the public API: no template
// reads ctx.error or ctx.file directly, and the regex mutant only touches a
// zero-width optional trailing class that never changes the captured
// group. Those are left still_open rather than asserted equivalent.

import { describe, expect, it } from "vitest";
import type { ToolFailureEvent, TriageResult } from "../types.js";
import { explainFailure } from "./failure-explanation.js";

function makeEvent(overrides: Partial<ToolFailureEvent> = {}): ToolFailureEvent {
	return {
		session_id: "s",
		agent_source: "claude",
		tool_name: "Edit",
		timestamp: "2026-05-09T00:00:00Z",
		...overrides,
	};
}

const triage = (
	label: TriageResult["label"],
	category: string,
): TriageResult => ({
	label,
	category,
	confidence: 0.85,
	source: "local-heuristic",
});

describe("explainFailure — exact full-text templates (kills fragment-deleting StringLiteral mutants)", () => {
	// test-contract: public-api — every fragment of missing-import must be present verbatim
	it("agent-error/missing-import produces the exact full sentence", () => {
		const out = explainFailure(
			makeEvent({ error_message: "Cannot find module './widget'" }),
			triage("agent-error", "missing-import"),
		);
		expect(out).toBe(
			"The module `./widget` couldn't be resolved. Common causes: " +
				"(1) the package isn't installed, " +
				"(2) the import path is wrong (typo, case-sensitive on Linux), " +
				"(3) the package's \"exports\" map doesn't expose this subpath, or " +
				"(4) tsconfig \"paths\" / \"moduleResolution\" needs updating.",
		);
	});

	// test-contract: public-api — every fragment of missing-symbol must be present verbatim
	it("agent-error/missing-symbol produces the exact full sentence", () => {
		const out = explainFailure(
			makeEvent({ error_message: "Cannot find name 'fooBar'" }),
			triage("agent-error", "missing-symbol"),
		);
		expect(out).toBe(
			"`fooBar` isn't a known name in this scope — TypeScript walked the " +
				"imports, locals, and globals and didn't find it. Either the import is " +
				"missing, the export was removed, or the name is misspelled.",
		);
	});

	// test-contract: public-api — every fragment of type-mismatch must be present verbatim
	it("agent-error/type-mismatch produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("agent-error", "type-mismatch"));
		expect(out).toBe(
			"TypeScript rejected the value because its declared type doesn't match the " +
				"expected type at this position. This catches real category errors at compile " +
				"time — the fix is almost always to change the value or its source type, not " +
				"the call site.",
		);
	});

	// test-contract: public-api — every fragment of missing-property must be present verbatim
	it("agent-error/missing-property produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("agent-error", "missing-property"));
		expect(out).toBe(
			"The property doesn't exist on the type's known shape. Either the type needs " +
				"updating to include it, or the access is on the wrong object.",
		);
	});

	// test-contract: public-api — every fragment of unused-declaration must be present verbatim
	it("agent-error/unused-declaration produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("agent-error", "unused-declaration"));
		expect(out).toBe(
			"A declared identifier was never referenced. The strict-tsconfig rule treats " +
				"this as a bug because most of the time it's a forgotten import or a stub that " +
				"outlived its purpose.",
		);
	});

	// test-contract: public-api — every fragment of git-conflict must be present verbatim
	it("agent-error/git-conflict produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("agent-error", "git-conflict"));
		expect(out).toBe(
			"Two histories disagreed on the same lines. Git can't pick a winner — you have " +
				"to read both sides, decide on the right answer, and remove the conflict markers.",
		);
	});

	// test-contract: public-api — every fragment of test-failure must be present verbatim
	it("agent-error/test-failure produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("agent-error", "test-failure"));
		expect(out).toBe(
			"The assertion the test expressed didn't hold against the implementation. Either " +
				"the implementation is wrong (most common when the test is specific and recent) " +
				"or the test's expectation is wrong (less common).",
		);
	});

	// test-contract: public-api — every fragment of auth must be present verbatim
	it("agent-error/auth produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("agent-error", "auth"));
		expect(out).toBe(
			"The provider rejected the credential. Either it's missing, expired, scoped " +
				"incorrectly, or revoked. Don't paste a new key into source — set it in the " +
				"environment.",
		);
	});

	// test-contract: public-api — every fragment of filesystem-missing must be present verbatim
	it("environmental/filesystem-missing produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("environmental", "filesystem-missing"));
		expect(out).toBe(
			"No file/directory exists at the path. The most common cause is a stale " +
				"assumption about where things are — verify with `ls` before retrying.",
		);
	});

	// test-contract: public-api — every fragment of filesystem-permission must be present verbatim
	it("environmental/filesystem-permission produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("environmental", "filesystem-permission"));
		expect(out).toBe(
			"The OS denied write access. The harness usually intercepts protected paths; " +
				"if it didn't, the path may not be in our protected set yet.",
		);
	});

	// test-contract: public-api — every fragment of network-refused must be present verbatim
	it("transient/network-refused produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("transient", "network-refused"));
		expect(out).toBe(
			"The target accepted the SYN packet but refused the connection — either the " +
				"port isn't listening or a firewall dropped the packet.",
		);
	});

	// test-contract: public-api — every fragment of rate-limit must be present verbatim
	it("transient/rate-limit produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("transient", "rate-limit"));
		expect(out).toBe(
			"The provider returned a rate-limit signal. Their server is intentionally " +
				"slowing this client down; respect the cooldown.",
		);
	});

	// test-contract: public-api — every fragment of process-crash must be present verbatim
	it("unrecoverable/process-crash produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("unrecoverable", "process-crash"));
		expect(out).toBe(
			"The subprocess crashed with a non-graceful signal — usually a memory bug in " +
				"the called program, not in the agent's input.",
		);
	});

	// test-contract: public-api — the agent-error fallback string must be exact
	it("agent-error fallback (unmatched category) produces the exact full sentence", () => {
		const out = explainFailure(makeEvent(), triage("agent-error", "no-such-category"));
		expect(out).toBe(
			"The error suggests a mistake on the agent side — code that doesn't compile, " +
				"a wrong path, or a bad assumption about the project's shape.",
		);
	});
});
