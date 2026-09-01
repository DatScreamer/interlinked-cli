// Cross-provider invariants. A new runner that only has a smoke test is not done:
// these must stay green for every adapter in buildAllAdapters().

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isFileWrite } from "../evaluator/tool-classifiers.js";
import { PROVIDER_BY_SOURCE } from "../server/agent-event-capture.js";
import { AGENT_SOURCES } from "../types/events.js";
import { DIRECT_FILE_EDIT_TOOLS } from "../../lib/write-tool-registry.js";
import { CLIENT_TO_RUNNER, detectClients } from "../../lib/settings.js";
import { buildAllAdapters } from "./index.js";
import type { RunnerId } from "../unified-event.js";

interface WriteFixture {
	nativeEvent: string;
	payload: Record<string, unknown>;
}

/** One native write/edit payload per runner. Missing an adapter id fails the suite. */
const WRITE_FIXTURES: Record<RunnerId, WriteFixture> = {
	"claude-code": {
		nativeEvent: "PreToolUse",
		payload: { session_id: "s", cwd: "/r", tool_name: "Write", tool_input: { file_path: "/r/a.ts", content: "x" } },
	},
	"copilot-cli": {
		nativeEvent: "preToolUse",
		payload: { sessionId: "s", cwd: "/r", toolName: "edit_file", toolInput: { path: "/r/a.ts" } },
	},
	cursor: {
		nativeEvent: "preToolUse",
		payload: { session_id: "s", cwd: "/r", tool_name: "Edit", tool_input: { file_path: "/r/a.ts" } },
	},
	"gemini-cli": {
		nativeEvent: "BeforeTool",
		payload: { session_id: "s", cwd: "/r", tool_name: "write_file", tool_input: { path: "/r/a.ts" } },
	},
	codex: {
		nativeEvent: "PreToolUse",
		payload: { session_id: "s", cwd: "/r", tool_name: "Write", tool_input: { file_path: "/r/a.ts", content: "x" } },
	},
	opencode: {
		nativeEvent: "tool.execute.before",
		payload: { sessionID: "s", cwd: "/r", tool: "edit", args: { file_path: "/r/a.ts" } },
	},
	opencode2: {
		nativeEvent: "tool.execute.before",
		payload: { sessionID: "s", cwd: "/r", tool: "write", args: { filePath: "/r/a.ts", content: "x" } },
	},
	pi: {
		nativeEvent: "tool_call",
		payload: { sessionId: "s", cwd: "/r", toolName: "edit", input: { file_path: "/r/a.ts" } },
	},
};

describe("agent_source maps are exhaustive", () => {
	it("PROVIDER_BY_SOURCE has a label for every AgentSource", () => {
		for (const source of AGENT_SOURCES) {
			expect(PROVIDER_BY_SOURCE[source], source).toEqual(expect.any(String));
			expect(PROVIDER_BY_SOURCE[source].length).toBeGreaterThan(0);
		}
		expect(Object.keys(PROVIDER_BY_SOURCE).sort()).toEqual([...AGENT_SOURCES].sort());
	});

	it("CLIENT_TO_RUNNER covers every client name and a live adapter", () => {
		const adapterIds = new Set(buildAllAdapters().map((a) => a.id));
		for (const runner of Object.values(CLIENT_TO_RUNNER)) {
			expect(adapterIds.has(runner), runner).toBe(true);
		}
	});
});

describe("every adapter's native write is a harness file-write", () => {
	it("WRITE_FIXTURES lists every adapter exactly once", () => {
		expect(Object.keys(WRITE_FIXTURES).sort()).toEqual(
			buildAllAdapters().map((a) => a.id).sort(),
		);
	});

	it("parsed write tool names are isFileWrite / direct edits (or file_operation)", () => {
		for (const adapter of buildAllAdapters()) {
			const fixture = WRITE_FIXTURES[adapter.id];
			const event = adapter.parseHookInput(fixture.payload, fixture.nativeEvent);
			if (event.action.kind === "file_operation") {
				expect(["create", "edit", "write", "delete"]).toContain(event.action.operation);
				continue;
			}
			expect(event.action.kind, adapter.id).toBe("tool_call");
			if (event.action.kind !== "tool_call") continue;
			const name = event.action.tool_name;
			expect(
				isFileWrite(name) || DIRECT_FILE_EDIT_TOOLS.includes(name),
				`${adapter.id} emitted ${name}, which is not a file write`,
			).toBe(true);
		}
	});

	it("isFileWrite agrees with DIRECT_FILE_EDIT_TOOLS", () => {
		for (const name of DIRECT_FILE_EDIT_TOOLS) {
			expect(isFileWrite(name), name).toBe(true);
		}
	});
});

describe("adapter detection", () => {
	it("no adapter claims a blank environment", () => {
		for (const adapter of buildAllAdapters()) {
			expect(adapter.detectFromEnv({}), adapter.id).toBe(false);
		}
	});
});

describe("detectClients shared config directories", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("a shared project dir without env selects at most one OpenCode client", () => {
		const cwd = mkdtempSync(join(tmpdir(), "prov-detect-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, ".opencode"));
		const names = detectClients(cwd, {}).filter((c) => c.exists).map((c) => c.name);
		const open = names.filter((n) => n === "opencode" || n === "opencode2");
		expect(open).toEqual(["opencode"]);
	});
});

describe("managed plugin install paths stay in-repo for project scope", () => {
	it("fileContent adapters use a project-relative path", () => {
		for (const adapter of buildAllAdapters()) {
			const frag = adapter.renderSettingsFragment("/bin/hook", "project");
			if (!frag.fileContent) continue;
			expect(frag.path.startsWith("~/"), adapter.id).toBe(false);
			expect(frag.path.startsWith("/"), adapter.id).toBe(false);
		}
	});
});
