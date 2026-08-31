import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "./types.js";
import { reservationTargetPaths } from "./reservation-target-paths.js";

const CWD = "/repo/worktree";

function event(toolInput: NonNullable<HarnessEvent["tool_input"]>, cwd = CWD): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "reservation-target-test",
		agent_source: "codex",
		tool_name: "apply_patch",
		tool_input: toolInput,
		cwd,
		timestamp: "2026-08-30T00:00:00.000Z",
	};
}

describe("reservationTargetPaths", () => {
	it("preserves named file_path and path aliases", () => {
		expect(reservationTargetPaths(event({ file_path: "src/a.ts" }), { file_path: "src/a.ts" })).toEqual([
			"src/a.ts",
		]);
		expect(reservationTargetPaths(event({ path: "/repo/b.ts" }), { path: "/repo/b.ts" })).toEqual([
			"/repo/b.ts",
		]);
	});

	it("uses file_path precedence and ignores non-string named values", () => {
		expect(
			reservationTargetPaths(event({ file_path: "src/a.ts", path: "src/b.ts" }), {
				file_path: "src/a.ts",
				path: "src/b.ts",
			}),
		).toEqual(["src/a.ts"]);
		expect(reservationTargetPaths(event({ file_path: 42, path: "src/b.ts" }), { file_path: 42, path: "src/b.ts" })).toEqual([
			"src/b.ts",
		]);
	});

	it("extracts every apply_patch destination and move source exactly once", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/old.ts",
			"*** Move to: src/new.ts",
			"@@",
			"-old",
			"+new",
			"*** Update File: src/new.ts",
			"@@",
			"-x",
			"+y",
			"*** Add File: docs/a.md",
			"+hello",
			"*** End Patch",
		].join("\n");

		expect(reservationTargetPaths(event({ command: patch }), { command: patch })).toEqual([
			resolve(CWD, "src/new.ts"),
			resolve(CWD, "src/old.ts"),
			resolve(CWD, "docs/a.md"),
		]);
	});

	it("falls back to process.cwd when the event omits cwd", () => {
		const patch = "*** Begin Patch\n*** Delete File: src/a.ts\n*** End Patch";
		const withoutCwd = event({ patch }, "");
		expect(reservationTargetPaths(withoutCwd, { patch })).toEqual([
			resolve(process.cwd(), "src/a.ts"),
		]);
	});

	it("rejects a malformed non-patch payload without inventing a target", () => {
		const targets = reservationTargetPaths(event({ command: "plain prose" }), {
			command: "plain prose",
		});
		expect(targets).toEqual([]);
		expect(targets).not.toContain("plain prose");
	});
});
