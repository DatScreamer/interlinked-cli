// Covers the `bash-code-file-write-bypass` block in evaluateDestructiveRules.
// `pre-tool-rules.ts` is a low-coverage module whose remediation message
// previously pointed agents at the now-removed MultiEdit tool; this test pins
// the message to the real primitive (`interlinked write --batch`) and is
// filename-corresponding so the per-edit overlay selects it (finding 2026-06:
// the block was full-suite-covered via supply-chain-defense.test.ts but the
// scoped overlay under-selected, so editing the message tripped the
// uncovered-added-line gate).

import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../rules-loader.js";
import type { HarnessEvent } from "../types.js";
import { evaluateDestructiveRules } from "./pre-tool-rules.js";

function bashEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "pre-tool-rules-test",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-06-15T00:00:00Z",
	} as HarnessEvent;
}

describe("evaluateDestructiveRules — bash-code-file-write-bypass", () => {
	it("blocks a shell redirect to a code file and recommends the real atomic primitive", () => {
		const decision = evaluateDestructiveRules(
			bashEvent("echo x > src/foo.ts"),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("bash-code-file-write-bypass");
		// The remediation must name the available primitive, NOT the removed
		// MultiEdit tool (finding 2026-06; MultiEdit is gone from Claude Code).
		expect(decision?.reason).toContain("interlinked write --batch");
	});

	it("does not block a redirect to a non-code file", () => {
		const decision = evaluateDestructiveRules(
			bashEvent("echo x > notes.txt"),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.rule_id).not.toBe("bash-code-file-write-bypass");
	});
});

describe("evaluateDestructiveRules — out-of-repo scratch/ steer (warn-only, 2026-07-07)", () => {
	function bashEventWithCwd(command: string): HarnessEvent {
		return { ...bashEvent(command), cwd: "/Users/dev/project" } as HarnessEvent;
	}

	it("warns (never blocks) on a code-file write outside the repo, steering to scratch/", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd("echo x > /tmp/probe.mts"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.rule_id).not.toBe("bash-code-file-write-bypass");
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(true);
		expect(warnings.join("\n")).toContain("scratch/");
	});

	it("does NOT emit the steer for an in-repo code write (the block path owns it)", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd("echo x > src/foo.ts"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.rule_id).toBe("bash-code-file-write-bypass");
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(false);
	});

	it("does NOT emit the steer for non-code out-of-repo writes", () => {
		const warnings: string[] = [];
		evaluateDestructiveRules(
			bashEventWithCwd("echo x > /tmp/notes.txt"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(false);
	});
});

describe("evaluateDestructiveRules — scratchpad code-write block (2026-07-09)", () => {
	// The fixture session id must appear as a path segment for the
	// session-scratchpad triad to match (see sessionScratchpadAllows).
	const SCRATCHPAD = "/tmp/claude-501/-Users-dev-project/pre-tool-rules-test/scratchpad";

	function bashEventWithCwd(command: string): HarnessEvent {
		return { ...bashEvent(command), cwd: "/Users/dev/project" } as HarnessEvent;
	}

	it("blocks a redirect into THIS session's scratchpad with the scratch/ redirect", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd(`echo x > ${SCRATCHPAD}/probe.ts`),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-scratchpad-code-write");
		expect(decision?.reason).toContain("scratch/");
	});

	it("blocks the $VAR form once the assignment resolves to the scratchpad", () => {
		const decision = evaluateDestructiveRules(
			bashEventWithCwd(`SCRATCH=${SCRATCHPAD} && cat > $SCRATCH/draft.ts <<'EOF'\nx\nEOF`),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.rule_id).toBe("builtin-scratchpad-code-write");
	});

	it("keeps the warn-only steer for a DIFFERENT session's scratchpad", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd("echo x > /tmp/claude-501/-Users-dev-project/other-session/scratchpad/probe.ts"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.rule_id).not.toBe("builtin-scratchpad-code-write");
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(true);
	});

	it("keeps the warn-only steer for non-scratchpad out-of-repo code writes", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd("echo x > /tmp/probe.mts"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.rule_id).not.toBe("builtin-scratchpad-code-write");
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(true);
	});

	it("honors the INTERLINKED_DISABLE_SCRATCH_GUARD escape hatch (warn instead)", () => {
		process.env.INTERLINKED_DISABLE_SCRATCH_GUARD = "1";
		try {
			const warnings: string[] = [];
			const decision = evaluateDestructiveRules(
				bashEventWithCwd(`echo x > ${SCRATCHPAD}/probe.ts`),
				getDefaultConfig(),
				undefined,
				warnings,
			);
			expect(decision?.rule_id).not.toBe("builtin-scratchpad-code-write");
			expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(true);
		} finally {
			delete process.env.INTERLINKED_DISABLE_SCRATCH_GUARD;
		}
	});
});
