// ===========================================
// harness-test-event — synthetic PreToolUse event construction
// ===========================================
// The flag→event mapping for `interlinked harness test --write/--edit` is a
// pure function (`buildHarnessTestEvent`) so it is unit-testable without a live
// daemon socket. `resolveHarnessTestInput` does the (async) flag + content
// resolution; node:fs is mocked so the --from-file / --stdin paths are scripted
// deterministically. Together they cover every event shape the harness reads
// (`pre-tool.ts`): Write `{ file_path, content }`, Edit
// `{ file_path, old_string, new_string }`, Bash/Shell `{ command }`.

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	readFileSync: mocks.readFileSync,
}));

import {
	buildHarnessTestEvent,
	type HarnessTestInput,
	resolveHarnessTestInput,
} from "./harness-test-event.js";

const CWD = "/repo";

// Restorers registered by pushStdin(); drained in afterEach so individual tests
// stay free of try/finally branching.
let stdinRestorers: Array<() => void>;

beforeEach(() => {
	for (const m of Object.values(mocks)) m.mockReset();
	stdinRestorers = [];
});

afterEach(() => {
	for (const restore of stdinRestorers) restore();
	vi.restoreAllMocks();
});

// Replace process.stdin with an in-memory readable so the --stdin path resolves
// without a real terminal. The restore runs in afterEach.
function pushStdin(content: string): void {
	const orig = Object.getOwnPropertyDescriptor(process, "stdin");
	const fake = Readable.from([Buffer.from(content, "utf-8")]);
	Object.defineProperty(process, "stdin", { value: fake, configurable: true });
	stdinRestorers.push(() => {
		if (orig) Object.defineProperty(process, "stdin", orig);
	});
}

// ===========================================================================
// buildHarnessTestEvent — pure mapping
// ===========================================================================

describe("buildHarnessTestEvent", () => {
	it("builds a Write event with file_path + content tool_input", () => {
		const plan = buildHarnessTestEvent({
			kind: "write",
			filePath: "/repo/src/foo.ts",
			content: "export const x = 1;\n",
		});
		expect(plan.toolName).toBe("Write");
		expect(plan.event.tool_input).toEqual({
			file_path: "/repo/src/foo.ts",
			content: "export const x = 1;\n",
		});
	});

	it("labels the Write event with the file path", () => {
		const plan = buildHarnessTestEvent({ kind: "write", filePath: "/repo/x.ts", content: "" });
		expect(plan.displayLabel).toBe("/repo/x.ts");
	});

	it("stamps the Write event with the fixed PreToolUse envelope", () => {
		const plan = buildHarnessTestEvent({ kind: "write", filePath: "/repo/x.ts", content: "" });
		expect(plan.event.hook_event).toBe("PreToolUse");
		expect(plan.event.session_id).toBe("cli-test");
		expect(plan.event.agent_source).toBe("claude");
		expect(typeof plan.event.timestamp).toBe("string");
	});

	it("builds an Edit event with old_string + new_string", () => {
		const plan = buildHarnessTestEvent({
			kind: "edit",
			filePath: "/repo/a.ts",
			oldString: "const a = 1",
			newString: "const a = 2",
		});
		expect(plan.toolName).toBe("Edit");
		expect(plan.event.tool_input).toEqual({
			file_path: "/repo/a.ts",
			old_string: "const a = 1",
			new_string: "const a = 2",
		});
	});

	it("builds a Bash event with command tool_input and labels it with the command", () => {
		const plan = buildHarnessTestEvent({ kind: "bash", toolName: "Bash", command: "rm -rf /" });
		expect(plan.toolName).toBe("Bash");
		expect(plan.displayLabel).toBe("rm -rf /");
		expect(plan.event.tool_input).toEqual({ command: "rm -rf /" });
	});

	it("treats Shell like Bash (command tool_input)", () => {
		const plan = buildHarnessTestEvent({ kind: "bash", toolName: "Shell", command: "echo hi" });
		expect(plan.event.tool_name).toBe("Shell");
		expect(plan.event.tool_input).toEqual({ command: "echo hi" });
	});

	it("routes a non-shell tool's command into file_path", () => {
		const plan = buildHarnessTestEvent({ kind: "bash", toolName: "Read", command: "/etc/passwd" });
		expect(plan.event.tool_name).toBe("Read");
		expect(plan.event.tool_input).toEqual({ file_path: "/etc/passwd" });
	});
});

// ===========================================================================
// resolveHarnessTestInput — flag + content resolution (I/O mocked)
// ===========================================================================

describe("resolveHarnessTestInput", () => {
	it("resolves --write --from-file by reading the source file (path made absolute)", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("file body");
		const input = await resolveHarnessTestInput(
			undefined,
			{ write: "out.ts", fromFile: "/tmp/proposed.ts" },
			CWD,
		);
		expect(input).toEqual<HarnessTestInput>({
			kind: "write",
			filePath: "/repo/out.ts",
			content: "file body",
		});
		expect(mocks.readFileSync).toHaveBeenCalledWith("/tmp/proposed.ts", "utf-8");
	});

	it("keeps an absolute --write path unchanged", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue("x");
		const input = await resolveHarnessTestInput(
			undefined,
			{ write: "/abs/out.ts", fromFile: "/tmp/p.ts" },
			CWD,
		);
		expect(input).toEqual<HarnessTestInput>({
			kind: "write",
			filePath: "/abs/out.ts",
			content: "x",
		});
	});

	it("resolves --write --stdin by draining stdin without touching the fs reader", async () => {
		pushStdin("stdin content");
		const input = await resolveHarnessTestInput(undefined, { write: "out.ts", stdin: true }, CWD);
		expect(input).toEqual<HarnessTestInput>({
			kind: "write",
			filePath: "/repo/out.ts",
			content: "stdin content",
		});
		expect(mocks.readFileSync).not.toHaveBeenCalled();
	});

	it("throws when --write has neither --from-file nor --stdin", async () => {
		await expect(resolveHarnessTestInput(undefined, { write: "out.ts" }, CWD)).rejects.toThrow(
			/--from-file <path> or --stdin/,
		);
	});

	it("throws when --from-file source is missing", async () => {
		mocks.existsSync.mockReturnValue(false);
		await expect(
			resolveHarnessTestInput(undefined, { write: "out.ts", fromFile: "/nope.ts" }, CWD),
		).rejects.toThrow(/Source file not found: \/nope\.ts/);
	});

	it("resolves --edit with --old and --new", async () => {
		const input = await resolveHarnessTestInput(
			undefined,
			{ edit: "src/a.ts", old: "a", new: "b" },
			CWD,
		);
		expect(input).toEqual<HarnessTestInput>({
			kind: "edit",
			filePath: "/repo/src/a.ts",
			oldString: "a",
			newString: "b",
		});
	});

	it("throws when --edit is missing --old", async () => {
		await expect(
			resolveHarnessTestInput(undefined, { edit: "a.ts", new: "b" }, CWD),
		).rejects.toThrow(/--edit requires both --old/);
	});

	it("throws when --edit is missing --new", async () => {
		await expect(
			resolveHarnessTestInput(undefined, { edit: "a.ts", old: "a" }, CWD),
		).rejects.toThrow(/--edit requires both --old/);
	});

	it("falls back to a Bash input for a positional command", async () => {
		const input = await resolveHarnessTestInput("ls -la", {}, CWD);
		expect(input).toEqual<HarnessTestInput>({ kind: "bash", toolName: "Bash", command: "ls -la" });
	});

	it("honors --tool for the positional fallback", async () => {
		const input = await resolveHarnessTestInput("/etc/passwd", { tool: "Read" }, CWD);
		expect(input).toEqual<HarnessTestInput>({
			kind: "bash",
			toolName: "Read",
			command: "/etc/passwd",
		});
	});

	it("throws when no command and no --write/--edit are provided", async () => {
		await expect(resolveHarnessTestInput(undefined, {}, CWD)).rejects.toThrow(/Provide a <command>/);
	});
});
