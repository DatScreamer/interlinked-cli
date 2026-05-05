import { describe, expect, it } from "vitest";
import {
	extractAllApplyPatchFilePaths,
	extractAllEditedFilePaths,
	extractApplyPatchFilePath,
	extractEditedFilePath,
	isPostToolUse,
	isPreToolUse,
	summarizeToolInput,
} from "./server-tool-helpers.js";
import type { HarnessEvent } from "./types.js";

function makeEvent(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

describe("summarizeToolInput", () => {
	it("summarizes Codex apply_patch to the edited file path", () => {
		expect(
			summarizeToolInput(
				makeEvent({
					tool_name: "apply_patch",
					tool_input: {
						command:
							"*** Begin Patch\n*** Update File: src/commands/enable.ts\n@@\n-print('a')\n+print('b')\n*** End Patch\n",
					},
				}),
			),
		).toBe("src/commands/enable.ts");
	});

	it("returns command truncated to 200 chars", () => {
		const cmd = "a".repeat(500);
		const out = summarizeToolInput(makeEvent({ tool_input: { command: cmd } }));
		expect(out.length).toBe(200);
	});

	it("returns file_path when command is absent", () => {
		expect(
			summarizeToolInput(
				makeEvent({ tool_name: "Edit", tool_input: { file_path: "/a/b.ts" } }),
			),
		).toBe("/a/b.ts");
	});

	it("returns url truncated when present", () => {
		const url = `https://${"x".repeat(300)}`;
		const out = summarizeToolInput(makeEvent({ tool_input: { url } }));
		expect(out.length).toBe(200);
	});

	it("falls back to tool_name when tool_input is missing", () => {
		expect(summarizeToolInput(makeEvent({ tool_name: "Read" }))).toBe("Read");
	});

	it("returns empty string when neither is present", () => {
		expect(summarizeToolInput(makeEvent({ tool_name: undefined }))).toBe("");
	});
});

describe("extractApplyPatchFilePath", () => {
	it("extracts the target path from update/add/delete patch headers", () => {
		expect(
			extractApplyPatchFilePath(
				"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch\n",
			),
		).toBe("src/a.ts");
		expect(
			extractApplyPatchFilePath(
				"*** Begin Patch\n*** Add File: src/b.ts\n+x\n*** End Patch\n",
			),
		).toBe("src/b.ts");
		expect(
			extractApplyPatchFilePath(
				"*** Begin Patch\n*** Delete File: src/c.ts\n*** End Patch\n",
			),
		).toBe("src/c.ts");
	});

	it("prefers the move destination when present", () => {
		expect(
			extractApplyPatchFilePath(
				"*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-x\n+y\n*** End Patch\n",
			),
		).toBe("src/new.ts");
	});
});

describe("extractAllApplyPatchFilePaths", () => {
	it("returns every section's path in order, applying Move-to retargets", () => {
		const patch =
			"*** Begin Patch\n" +
			"*** Update File: src/a.ts\n" +
			"@@\n-x\n+y\n" +
			"*** Add File: src/b.ts\n" +
			"+x\n" +
			"*** Update File: src/c-old.ts\n" +
			"*** Move to: src/c-new.ts\n" +
			"@@\n-z\n+w\n" +
			"*** Delete File: src/d.ts\n" +
			"*** End Patch\n";
		expect(extractAllApplyPatchFilePaths(patch)).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c-new.ts",
			"src/d.ts",
		]);
	});

	it("dedups paths that appear twice (e.g. update + move-to-self)", () => {
		const patch =
			"*** Begin Patch\n" +
			"*** Update File: src/a.ts\n" +
			"*** Move to: src/a.ts\n" +
			"@@\n-x\n+y\n" +
			"*** End Patch\n";
		expect(extractAllApplyPatchFilePaths(patch)).toEqual(["src/a.ts"]);
	});

	it("returns an empty array when no sections are present", () => {
		expect(extractAllApplyPatchFilePaths("not a patch")).toEqual([]);
	});
});

describe("extractEditedFilePath", () => {
	it("uses explicit file metadata when present", () => {
		expect(
			extractEditedFilePath(makeEvent({ tool_name: "Edit", tool_input: { file_path: "a.ts" } })),
		).toBe("a.ts");
	});

	it("falls back to files_modified when the hook already resolved the path", () => {
		expect(
			extractEditedFilePath(makeEvent({ files_modified: ["b.ts"], tool_input: {} })),
		).toBe("b.ts");
	});

	it("parses Codex apply_patch payloads", () => {
		expect(
			extractEditedFilePath(
				makeEvent({
					tool_name: "apply_patch",
					tool_input: {
						command:
							"*** Begin Patch\n*** Update File: src/harness/server.ts\n@@\n-x\n+y\n*** End Patch\n",
					},
				}),
			),
		).toBe("src/harness/server.ts");
	});
});

describe("extractAllEditedFilePaths", () => {
	it("returns every path from a multi-file apply_patch", () => {
		const patch =
			"*** Begin Patch\n" +
			"*** Update File: src/a.ts\n@@\n-x\n+y\n" +
			"*** Add File: src/b.ts\n+x\n" +
			"*** End Patch\n";
		expect(
			extractAllEditedFilePaths(
				makeEvent({ tool_name: "apply_patch", tool_input: { command: patch } }),
			),
		).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("returns the explicit single path when present (Edit tool, etc.)", () => {
		expect(
			extractAllEditedFilePaths(
				makeEvent({ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }),
			),
		).toEqual(["src/a.ts"]);
	});

	it("falls back to files_modified for non-apply_patch events without explicit path", () => {
		expect(
			extractAllEditedFilePaths(
				makeEvent({ files_modified: ["a.ts", "b.ts"], tool_input: {} }),
			),
		).toEqual(["a.ts", "b.ts"]);
	});

	it("returns an empty array when no paths can be resolved", () => {
		expect(extractAllEditedFilePaths(makeEvent({ tool_input: {} }))).toEqual([]);
	});

	// Parity with the hook-side normalizer in `lib/hooks-template.ts:1130`,
	// which reads `command || patch || content || _raw_patch`. If the
	// server-only reads `command`, every Codex/Copilot patch event delivered
	// under one of the alternate field names is silently skipped — including
	// the new Supermodel-graph PreToolUse warnings that fan out per file.
	it.each([
		["patch", "patch"],
		["content", "content"],
		["_raw_patch", "_raw_patch"],
	])(
		"reads apply_patch payload from tool_input.%s",
		(_label: string, field: string) => {
			const patch =
				"*** Begin Patch\n" +
				"*** Update File: src/x.ts\n@@\n-x\n+y\n" +
				"*** Add File: src/y.ts\n+y\n" +
				"*** End Patch\n";
			expect(
				extractAllEditedFilePaths(
					makeEvent({ tool_name: "apply_patch", tool_input: { [field]: patch } }),
				),
			).toEqual(["src/x.ts", "src/y.ts"]);
		},
	);
});

describe("isPreToolUse", () => {
	it("matches PreToolUse and BeforeTool", () => {
		expect(isPreToolUse(makeEvent({ hook_event: "PreToolUse" }))).toBe(true);
		expect(isPreToolUse(makeEvent({ hook_event: "BeforeTool" }))).toBe(true);
	});
	it("does not match post/other events", () => {
		expect(isPreToolUse(makeEvent({ hook_event: "PostToolUse" }))).toBe(false);
		expect(isPreToolUse(makeEvent({ hook_event: "SessionStart" }))).toBe(false);
	});
});

describe("isPostToolUse", () => {
	it("matches PostToolUse, AfterTool, PostToolUseFailure", () => {
		expect(isPostToolUse(makeEvent({ hook_event: "PostToolUse" }))).toBe(true);
		expect(isPostToolUse(makeEvent({ hook_event: "AfterTool" }))).toBe(true);
		expect(isPostToolUse(makeEvent({ hook_event: "PostToolUseFailure" }))).toBe(true);
	});
	it("does not match pre/other events", () => {
		expect(isPostToolUse(makeEvent({ hook_event: "PreToolUse" }))).toBe(false);
		expect(isPostToolUse(makeEvent({ hook_event: "SessionEnd" }))).toBe(false);
	});
});
