import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CLAUDE_HOOK_EVENTS,
	CODEX_HOOK_EVENTS,
	COPILOT_HOOK_EVENTS,
	CURSOR_HOOK_EVENTS,
	GEMINI_HOOK_EVENTS,
	installCopilotHooks,
} from "../hook-installers.js";

// The per-client install/uninstall behaviour is tested directly against each
// SUT in `hook-installers-<client>.test.ts`. This file pins the *barrel*: the
// `hook-installers.ts` re-export surface that `hooks.ts` (and other importers)
// consume must keep resolving every public symbol through the barrel after the
// per-client decomposition.

describe("hook-installers barrel — re-export surface", () => {
	it("re-exports every client event list through the barrel", () => {
		// Each list resolves through `../hook-installers.js`, not the sibling
		// module directly — proving the barrel forwards them.
		expect(CLAUDE_HOOK_EVENTS).toContain("SessionStart");
		expect(CLAUDE_HOOK_EVENTS).toContain("PostToolUse");
		// PostToolUseFailure is intentionally omitted (see CLAUDE_HOOK_EVENTS).
		expect(CLAUDE_HOOK_EVENTS).not.toContain("PostToolUseFailure");

		expect(COPILOT_HOOK_EVENTS).toContain("sessionStart");
		expect(COPILOT_HOOK_EVENTS).toContain("postToolUse");

		expect(GEMINI_HOOK_EVENTS).toContain("BeforeTool");
		expect(GEMINI_HOOK_EVENTS).toContain("AfterTool");

		expect(CODEX_HOOK_EVENTS).toContain("SessionStart");
		expect(CODEX_HOOK_EVENTS).toContain("UserPromptSubmit");
		expect(CODEX_HOOK_EVENTS).toContain("PreToolUse");
		expect(CODEX_HOOK_EVENTS).toContain("PostToolUse");
		expect(CODEX_HOOK_EVENTS).toContain("PermissionRequest");
		expect(CODEX_HOOK_EVENTS).toContain("Stop");

		expect(CURSOR_HOOK_EVENTS).toContain("beforeMCPExecution");
		expect(CURSOR_HOOK_EVENTS).toContain("beforeMcpToolExecution");
	});

	it("re-exports a working install function (Copilot smoke test through barrel)", () => {
		const tmp = mkdtempSync(join(tmpdir(), "barrel-smoke-"));
		try {
			installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
			const content = readFileSync(join(tmp, ".github", "hooks", "hooks.json"), "utf-8");
			expect(content).toContain("interlinked-activity");
			expect(content).toContain("INTERLINKED_CLIENT");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
