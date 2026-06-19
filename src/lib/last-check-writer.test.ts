import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessDecision } from "../harness/types.js";
import type { UnifiedHookEvent } from "../harness/unified-event.js";
import {
	deriveLastCheckFields,
	extractEventFile,
	formatLastCheckLine,
	writeLastCheckArtifact,
	writeNoHarnessArtifact,
} from "./last-check-writer.js";

function makeEvent(overrides: {
	phase?: UnifiedHookEvent["phase"];
	toolName?: string;
	toolInput?: unknown;
	kind?: "tool_call" | "shell_command";
	cwd?: string;
}): UnifiedHookEvent {
	const cwd = overrides.cwd ?? "/repo";
	const action =
		overrides.kind === "shell_command"
			? { kind: "shell_command" as const, command: "rm -rf /", cwd }
			: {
					kind: "tool_call" as const,
					tool_name: overrides.toolName ?? "edit",
					tool_class: "file_write" as never,
					tool_input: overrides.toolInput ?? { file_path: "/repo/src/a.ts" },
					tool_input_redacted: null,
				};
	return {
		schema_version: "1",
		event_id: "e1",
		session_id: "s1",
		ts: "2026-06-12T00:00:00.000Z",
		runner: "claude-code" as never,
		runner_native_event: "PreToolUse",
		phase: overrides.phase ?? "pre-tool",
		action: action as never,
		context: { cwd },
		raw: null,
	} as UnifiedHookEvent;
}

describe("formatLastCheckLine", () => {
	it("joins key=value with pipes, skipping empties and sanitizing delimiters", () => {
		const line = formatLastCheckLine({
			result: "block",
			tool: "Bash",
			file: "",
			summary: "BLOCKED: a | b\nsecond line",
			rule: "builtin-x",
		});
		expect(line).toBe("result=block | tool=Bash | summary=BLOCKED: a   b second line | rule=builtin-x");
	});
});

describe("extractEventFile", () => {
	it("returns the cwd-relative file for tool calls and empty for shell commands", () => {
		expect(extractEventFile(makeEvent({}))).toBe("src/a.ts");
		expect(
			extractEventFile(makeEvent({ toolInput: { notebook_path: "/repo/n.ipynb" } })),
		).toBe("n.ipynb");
		expect(extractEventFile(makeEvent({ toolInput: { other: 1 } }))).toBe("");
		expect(extractEventFile(makeEvent({ kind: "shell_command" }))).toBe("");
	});
});

describe("deriveLastCheckFields", () => {
	it("maps a pre-tool block with first-line summary capped at 80 chars and the rule id", () => {
		const decision: HarnessDecision = {
			decision: "block",
			reason: `${"x".repeat(120)}\nrest`,
			rule_id: "builtin-kill-multi-pid",
		};
		const f = deriveLastCheckFields(makeEvent({ kind: "shell_command" }), decision, 12);
		expect(f).toMatchObject({ result: "block", tool: "Bash", rule: "builtin-kill-multi-pid" });
		expect(f?.summary).toHaveLength(80);
	});

	it("maps post-tool warnings to warn (with count) and no warnings to clean (with ms)", () => {
		const warn = deriveLastCheckFields(
			makeEvent({ phase: "post-tool" }),
			{ decision: "allow", warnings: ["a", "b"] },
			240,
		);
		expect(warn).toMatchObject({ result: "warn", count: 2, ms: 240, file: "src/a.ts" });
		const clean = deriveLastCheckFields(
			makeEvent({ phase: "post-tool" }),
			{ decision: "allow", warnings: [] },
			88,
		);
		expect(clean).toMatchObject({ result: "clean", ms: 88 });
	});

	it("returns null for pre-tool allow/ask and lifecycle phases", () => {
		expect(deriveLastCheckFields(makeEvent({}), { decision: "allow" }, 5)).toBeNull();
		expect(deriveLastCheckFields(makeEvent({}), { decision: "ask" }, 5)).toBeNull();
		expect(
			deriveLastCheckFields(makeEvent({ phase: "session-start" }), { decision: "allow" }, 5),
		).toBeNull();
	});
});

describe("writeLastCheckArtifact", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lastcheck-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the line for a qualifying event and skips non-qualifying ones", () => {
		writeLastCheckArtifact(
			dir,
			makeEvent({ phase: "post-tool" }),
			{ decision: "allow", warnings: ["w"] },
			31,
		);
		const body = readFileSync(join(dir, "last-check.txt"), "utf8");
		expect(body).toContain("result=warn");
		expect(body).toContain("count=1");
		// Pre-tool allow must not clobber the file.
		writeLastCheckArtifact(dir, makeEvent({}), { decision: "allow" }, 2);
		expect(readFileSync(join(dir, "last-check.txt"), "utf8")).toContain("result=warn");
	});

	it("writes no_harness for post-tool daemon outages and skips pre-tool ones", () => {
		writeNoHarnessArtifact(dir, makeEvent({ phase: "post-tool" }), 17);
		const body = readFileSync(join(dir, "last-check.txt"), "utf8");
		expect(body).toContain("result=no_harness");
		expect(body).toContain("ms=17");
		writeNoHarnessArtifact(dir, makeEvent({}), 3);
		expect(readFileSync(join(dir, "last-check.txt"), "utf8")).toContain("result=no_harness");
	});
});
