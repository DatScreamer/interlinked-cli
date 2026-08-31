import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHookScript } from "../hooks-template.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("generated hook daemon discovery", () => {
	it("does not connect a nested linked worktree to the parent checkout daemon", async () => {
		// Keep the Unix socket path under macOS's sockaddr_un limit.
		const root = mkdtempSync(join(tmpdir(), "il-wt-"));
		roots.push(root);
		const parentRuntime = join(root, ".interlinked");
		const worktree = join(root, ".worktrees", "branch");
		const worktreeRuntime = join(worktree, ".interlinked");
		mkdirSync(join(parentRuntime, "hooks"), { recursive: true });
		mkdirSync(worktreeRuntime, { recursive: true });
		writeFileSync(join(worktree, ".git"), "gitdir: ../../.git/worktrees/branch\n");
		writeFileSync(join(worktreeRuntime, "harness.pid"), String(process.pid));

		const parentSocket = join(parentRuntime, "harness.sock");
		let connections = 0;
		const server = createServer((socket) => {
			connections++;
			socket.end(`${JSON.stringify({ decision: "allow" })}\n`);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(parentSocket, resolve);
		});

		const script = join(parentRuntime, "hooks", "interlinked-activity.mjs");
		writeFileSync(script, buildHookScript("worktree-boundary-test"));
		try {
			const result = await new Promise<{ status: number | null; stderr: string }>(
				(resolve, reject) => {
					const child = spawn(process.execPath, [script], {
						cwd: worktree,
						env: {
							...process.env,
							INTERLINKED_CLIENT: "codex",
							INTERLINKED_HOME: worktreeRuntime,
							INTERLINKED_DATA_DIR: worktreeRuntime,
						},
					});
					let stderr = "";
					child.stderr.on("data", (chunk: Buffer) => {
						stderr += chunk.toString();
					});
					child.once("error", reject);
					child.once("close", (status) => resolve({ status, stderr }));
					child.stdin.end(
						JSON.stringify({
							hook_event_name: "PreToolUse",
							session_id: "worktree-session",
							cwd: worktree,
							tool_name: "Bash",
							tool_input: { command: "echo safe" },
						}),
					);
				},
			);

			expect(result.status, result.stderr).toBe(0);
			expect(connections).toBe(0);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
