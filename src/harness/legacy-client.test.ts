import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessDecision, HarnessEvent } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";
import {
	callLegacyHarness,
	isLegacyHarnessSocket,
	toLegacyHarnessEvent,
} from "./legacy-client.js";

let tmp = "";
let server: Server | null = null;
let sockets: Set<Socket> = new Set();

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-legacy-"));
});

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets = new Set();
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;
	}
	rmSync(tmp, { recursive: true, force: true });
});

function makePreEditEvent(): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "evt-1",
		session_id: "s1",
		ts: "2026-05-05T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: "pre-tool",
		action: {
			kind: "tool_call",
			tool_name: "edit",
			tool_class: "modify",
			tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			tool_input_redacted: { file_path: "src/a.ts" },
		},
		context: { cwd: tmp, agent: { id: "agent-a" } },
		raw: {
			session_id: "s1",
			cwd: tmp,
			tool_name: "Edit",
			tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			tool_use_id: "tool-1",
		},
	};
}

function listen(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
	server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		onConnection(socket);
	});
	return new Promise((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(path, () => resolve(server as Server));
	});
}

describe("isLegacyHarnessSocket", () => {
	it("detects only the repo-scoped legacy socket name", () => {
		expect(isLegacyHarnessSocket(join(tmp, "harness.sock"))).toBe(true);
		expect(isLegacyHarnessSocket(join(tmp, "harness-s1.sock"))).toBe(false);
	});
});

describe("toLegacyHarnessEvent", () => {
	it("converts a unified Claude PreToolUse edit into the raw HarnessEvent shape", () => {
		const legacy = toLegacyHarnessEvent(makePreEditEvent());
		expect(legacy).toMatchObject({
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			agent_name: "agent-a",
			tool_name: "Edit",
			tool_use_id: "tool-1",
			cwd: tmp,
			tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
		});
		expect("id" in legacy).toBe(false);
		expect("method" in legacy).toBe(false);
	});
});

describe("callLegacyHarness", () => {
	it("sends raw JSON and reads one raw HarnessDecision line", async () => {
		const socketPath = join(tmp, "harness.sock");
		const received: HarnessEvent[] = [];
		await listen(socketPath, (socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf-8");
				const idx = buffer.indexOf("\n");
				if (idx === -1) return;
				received.push(JSON.parse(buffer.slice(0, idx)) as HarnessEvent);
				const decision: HarnessDecision = {
					decision: "allow",
					warnings: ["legacy warning"],
				};
				socket.write(`${JSON.stringify(decision)}\n`);
			});
		});

		const decision = await callLegacyHarness(socketPath, makePreEditEvent(), {
			timeout_ms: 250,
		});

		expect(decision).toEqual({ decision: "allow", warnings: ["legacy warning"] });
		expect(received[0]?.hook_event).toBe("PreToolUse");
		expect(received[0]?.tool_name).toBe("Edit");
		expect("id" in (received[0] ?? {})).toBe(false);
		expect("method" in (received[0] ?? {})).toBe(false);
	});

	it("rejects with timeout when the legacy daemon accepts but never replies", async () => {
		const socketPath = join(tmp, "harness.sock");
		await listen(socketPath, () => {
			// Intentionally keep the socket open without writing a response.
		});

		await expect(
			callLegacyHarness(socketPath, makePreEditEvent(), { timeout_ms: 25 }),
		).rejects.toThrow("timeout");
	});
});
