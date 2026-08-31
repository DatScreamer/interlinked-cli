import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface WorkerResult {
	actor: string;
	status: string;
	message?: string;
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-gated-race-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!paths.every((path) => existsSync(path))) {
		if (Date.now() >= deadline) throw new Error(`workers did not become ready: ${paths.join(", ")}`);
		await wait(10);
	}
}

function parseWorkerResult(stdout: string, stderr: string, exitCode: number | null): WorkerResult {
	if (exitCode !== 0) throw new Error(`worker exited ${String(exitCode)}: ${stderr}`);
	const parsed: unknown = JSON.parse(stdout.trim());
	if (typeof parsed !== "object" || parsed === null) throw new Error(`invalid worker result: ${stdout}`);
	const actor = Reflect.get(parsed, "actor");
	const status = Reflect.get(parsed, "status");
	const message = Reflect.get(parsed, "message");
	if (typeof actor !== "string" || typeof status !== "string") {
		throw new Error(`invalid worker result: ${stdout}`);
	}
	return {
		actor,
		status,
		...(typeof message === "string" ? { message } : {}),
	};
}

function runWorker(actor: string, delayMs: number): Promise<WorkerResult> {
	const worker = fileURLToPath(
		new URL("./__tests__/fixtures/gated-file-transaction-worker.ts", import.meta.url),
	);
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", worker, root, actor, String(delayMs)],
			{ cwd: process.cwd() },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("close", (exitCode) => {
			try {
				resolve(parseWorkerResult(stdout, stderr, exitCode));
			} catch (error) {
				reject(error);
			}
		});
	});
}

describe("gated file transaction process race", () => {
	it("lets one same-baseline process commit and makes the later committer fail CAS", async () => {
		writeFileSync(join(root, "target.txt"), "base");
		const first = runWorker("actor-a", 0);
		const second = runWorker("actor-b", 250);
		await waitForFiles([join(root, "ready-actor-a"), join(root, "ready-actor-b")]);
		writeFileSync(join(root, "go"), "go");

		const results = await Promise.all([first, second]);

		expect(results).toEqual([
			{ actor: "actor-a", status: "ok" },
			expect.objectContaining({ actor: "actor-b", status: "conflict" }),
		]);
		expect(results[1]?.message).toContain("no files changed");
		expect(readFileSync(join(root, "target.txt"), "utf-8")).toBe("actor-a");
	});
});
