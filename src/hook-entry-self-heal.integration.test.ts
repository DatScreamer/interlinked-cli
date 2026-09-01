import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

function runRecoveryProcess(launcher: string, root: string, server: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", launcher, root, server],
			{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
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
		child.once("close", (code) => {
			if (code === 0) resolve(stdout.trim());
			else reject(new Error(`recovery child exited ${String(code)}: ${stderr}`));
		});
	});
}

async function waitForSpawn(root: string): Promise<number[]> {
	const log = join(root, ".interlinked", "canonical-spawns.log");
	for (let attempt = 0; attempt < 100 && !existsSync(log); attempt++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map(Number);
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		const log = join(root, ".interlinked", "canonical-spawns.log");
		if (existsSync(log)) {
			for (const pid of readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map(Number)) {
				try {
					process.kill(pid, "SIGTERM");
				} catch (error) {
					if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
						throw error;
					}
				}
			}
		}
		rmSync(root, { recursive: true, force: true });
	}
});

describe("canonical hook self-heal across short-lived hook processes", () => {
	it("transfers the mutex to the daemon so a four-process burst spawns one child", async () => {
		const root = mkdtempSync(join(tmpdir(), "il-canonical-heal-"));
		roots.push(root);
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(join(root, ".interlinked", "config.json"), "{}");

		const server = join(root, "fake-server.mjs");
		writeFileSync(
			server,
			[
				'import { appendFileSync } from "node:fs";',
				'import { join } from "node:path";',
				'const i = process.argv.indexOf("--cwd");',
				'const root = process.argv[i + 1];',
				'appendFileSync(join(root, ".interlinked", "canonical-spawns.log"), `${process.pid}\\n`);',
				"setTimeout(() => process.exit(0), 10_000);",
			].join("\n"),
		);

		const source = pathToFileURL(join(process.cwd(), "src", "hook-entry-daemon-gate.ts")).href;
		const launcher = join(root, "recover.mjs");
		writeFileSync(
			launcher,
			[
				`import { attemptDaemonSelfHeal } from ${JSON.stringify(source)};`,
				"const [root, server] = process.argv.slice(2);",
				"const result = attemptDaemonSelfHeal(root, {}, {",
				"  resolveServerPath: () => server,",
				"  dryRun: true,",
				"});",
				"process.stdout.write(result);",
			].join("\n"),
		);

		// Let the first short-lived hook exit before the next three arrive. Under
		// the old ownership bug its lock became stale here and every later process
		// could steal it; the child-owned lease remains live instead.
		expect(await runRecoveryProcess(launcher, root, server)).toBe("spawned");
		expect(await waitForSpawn(root)).toHaveLength(1);
		const followers = await Promise.all(
			Array.from({ length: 3 }, () => runRecoveryProcess(launcher, root, server)),
		);
		expect(followers).toEqual(["locked", "locked", "locked"]);
		expect(await waitForSpawn(root)).toHaveLength(1);
	});
});
