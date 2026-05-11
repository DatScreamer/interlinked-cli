// ===========================================
// checkSupermodelShardWrite — apply_patch-aware shard write protection
// ===========================================
// The builtin `builtin-supermodel-graph-write-blocked` rule covers writes
// where `tool_input.file_path` is the shard path. Codex `apply_patch`
// payloads embed paths inside the patch body — a regex-pattern rule on
// `field: file_path` can't see them. This module is the second layer.
//
// See `docs/design/graph-prediction-protocol.md §9.2`.

import { describe, expect, it } from "vitest";
import { checkSupermodelShardWrite } from "../supermodel-shard-write-guard.js";
import type { HarnessEvent } from "../types.js";

const baseEvent = (overrides: Partial<HarnessEvent>): HarnessEvent => ({
	hook_event: "PreToolUse",
	session_id: "s",
	agent_source: "claude",
	tool_name: "Edit",
	tool_input: {},
	timestamp: "2026-05-10T00:00:00Z",
	...overrides,
});

describe("checkSupermodelShardWrite", () => {
	it("returns null for non-file-write tools (Bash, Read, Grep)", () => {
		expect(
			checkSupermodelShardWrite(
				baseEvent({ tool_name: "Bash", tool_input: { command: "echo foo.graph.go" } }),
			),
		).toBeNull();
		expect(
			checkSupermodelShardWrite(
				baseEvent({ tool_name: "Read", tool_input: { file_path: "src/foo.graph.go" } }),
			),
		).toBeNull();
		expect(
			checkSupermodelShardWrite(
				baseEvent({ tool_name: "Grep", tool_input: { pattern: ".graph" } }),
			),
		).toBeNull();
	});

	it("returns null when no edited path matches the shard regex", () => {
		expect(
			checkSupermodelShardWrite(
				baseEvent({ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } }),
			),
		).toBeNull();
		expect(
			checkSupermodelShardWrite(
				baseEvent({ tool_name: "Write", tool_input: { file_path: "src/grapher.ts" } }),
			),
		).toBeNull();
	});

	it("blocks Write to a `.graph.<ext>` file", () => {
		const result = checkSupermodelShardWrite(
			baseEvent({ tool_name: "Write", tool_input: { file_path: "src/handler.graph.go" } }),
		);
		expect(result).not.toBeNull();
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/handler\.graph\.go/);
		expect(result?.reason).toMatch(/Supermodel/i);
	});

	it("blocks Edit to a bare `.graph` extension-less shard", () => {
		const result = checkSupermodelShardWrite(
			baseEvent({ tool_name: "Edit", tool_input: { file_path: "Makefile.graph" } }),
		);
		expect(result?.block).toBe(true);
	});

	it("blocks NotebookEdit when the notebook path is a shard", () => {
		const result = checkSupermodelShardWrite(
			baseEvent({
				tool_name: "NotebookEdit",
				tool_input: { notebook_path: "experiments/run.graph.ipynb" },
			}),
		);
		expect(result?.block).toBe(true);
	});

	it("blocks apply_patch even when the shard path is embedded in the patch body", () => {
		const patch = `*** Begin Patch
*** Update File: src/foo/handler.graph.go
@@
- old line
+ new line
*** End Patch`;
		const result = checkSupermodelShardWrite(
			baseEvent({ tool_name: "apply_patch", tool_input: { command: patch } }),
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/handler\.graph\.go/);
	});

	it("blocks apply_patch when ANY of multiple files in the patch is a shard", () => {
		const patch = `*** Begin Patch
*** Update File: src/foo/handler.go
@@
- old
+ new
*** Update File: src/foo/handler.graph.go
@@
- gold
+ gnew
*** End Patch`;
		const result = checkSupermodelShardWrite(
			baseEvent({ tool_name: "apply_patch", tool_input: { patch } }),
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/handler\.graph\.go/);
	});

	it("does not match files with `graph` only as a path component, not the suffix", () => {
		expect(
			checkSupermodelShardWrite(
				baseEvent({ tool_name: "Write", tool_input: { file_path: "src/graph/index.ts" } }),
			),
		).toBeNull();
		expect(
			checkSupermodelShardWrite(
				baseEvent({ tool_name: "Write", tool_input: { file_path: "src/graphlib.ts" } }),
			),
		).toBeNull();
	});

	it("returns null on apply_patch with no file headers (malformed payload)", () => {
		expect(
			checkSupermodelShardWrite(
				baseEvent({
					tool_name: "apply_patch",
					tool_input: { command: "garbage with no patch headers" },
				}),
			),
		).toBeNull();
	});
});
