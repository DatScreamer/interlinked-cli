import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalProjectRoot,
	PROJECT_LEASE_HARD_MAX_AGE_MS,
	tryAcquireCrossProcessCompilerLease,
} from "./project-compiler-lock.js";

const CHILD_PROGRAM = [
	'import { tryAcquireCrossProcessCompilerLease, canonicalProjectRoot } from "./src/harness/project-compiler-lock.ts";',
	"const root = process.argv[1];",
	"const lease = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));",
	'if (!lease) { process.stdout.write("busy\\n"); process.exit(0); }',
	'process.stdout.write("acquired\\n");',
	"setInterval(() => {}, 1000);",
].join("\n");

const RACING_CHILD_PROGRAM = [
	'import { existsSync } from "node:fs";',
	'import { tryAcquireCrossProcessCompilerLease, canonicalProjectRoot } from "./src/harness/project-compiler-lock.ts";',
	"const root = process.argv[1];",
	"const go = process.argv[2];",
	"const wait = new Int32Array(new SharedArrayBuffer(4));",
	'process.stdout.write("ready\\n");',
	"while (!existsSync(go)) Atomics.wait(wait, 0, 0, 1);",
	"const lease = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));",
	'process.stdout.write(lease ? "acquired\\n" : "busy\\n");',
	"if (lease) { Atomics.wait(wait, 0, 0, 1000); lease.release(); }",
].join("\n");

function spawnContender(root: string): ChildProcess {
	return spawn(process.execPath, ["--import", "tsx", "--eval", CHILD_PROGRAM, root], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

interface RacingContender {
	child: ChildProcess;
	ready: Promise<void>;
	result: Promise<string>;
}

function spawnRacingContender(root: string, goPath: string): RacingContender {
	const child = spawn(
		process.execPath,
		["--import", "tsx", "--eval", RACING_CHILD_PROGRAM, root, goPath],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	let pending = "";
	let resolveReady = (): void => undefined;
	let resolveResult = (_line: string): void => undefined;
	const ready = new Promise<void>((resolveReadyPromise) => {
		resolveReady = resolveReadyPromise;
	});
	const result = new Promise<string>((resolveResultPromise, rejectResult) => {
		resolveResult = resolveResultPromise;
		child.once("error", rejectResult);
		child.once("exit", (code) => {
			if (code !== 0) rejectResult(new Error(`racing contender exited ${String(code)}`));
		});
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf-8");
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline < 0) break;
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			if (line === "ready") resolveReady();
			else resolveResult(line);
		}
	});
	return { child, ready, result };
}

function compilerLockPath(projectRoot: string): string {
	const key = canonicalProjectRoot(projectRoot);
	const digest = createHash("sha256").update(key).digest("hex");
	return join(tmpdir(), "interlinked-project-compiler-leases-v1", `${digest}.lock`);
}

function writeSyntheticOwner(projectRoot: string, owner: Record<string, unknown>): void {
	const path = compilerLockPath(projectRoot);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "owner.json"), JSON.stringify(owner));
}

function firstOutputLine(child: ChildProcess): Promise<string> {
	return new Promise<string>((resolveLine, rejectLine) => {
		let pending = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			pending += chunk.toString("utf-8");
			const newline = pending.indexOf("\n");
			if (newline >= 0) resolveLine(pending.slice(0, newline));
		});
		child.once("error", rejectLine);
	});
}

function childExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise<void>((resolveExit) => {
		child.once("exit", () => resolveExit());
	});
}

describe("cross-process project compiler lease", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-compiler-lock-"));
	});

	afterEach(() => {
		rmSync(compilerLockPath(root), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});

	it("canonicalization is idempotent", () => {
		fc.assert(
			fc.property(fc.string(), (path) => {
				expect(canonicalProjectRoot(canonicalProjectRoot(path))).toBe(canonicalProjectRoot(path));
			}),
		);
	});

	it("refuses a second process while this process owns the same project", async () => {
		const lease = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(lease).not.toBeNull();
		const child = spawnContender(root);
		await expect(firstOutputLine(child)).resolves.toBe("busy");
		await childExit(child);
		lease?.release();
	});

	it("maps a symlink alias to the same lock across processes", async () => {
		const alias = `${root}-alias`;
		symlinkSync(root, alias);
		const lease = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(lease).not.toBeNull();
		try {
			const child = spawnContender(alias);
			await expect(firstOutputLine(child)).resolves.toBe("busy");
			await childExit(child);
		} finally {
			lease?.release();
			rmSync(alias, { force: true });
		}
	});

	it("recovers a lock whose owner process was killed", async () => {
		const child = spawnContender(root);
		await expect(firstOutputLine(child)).resolves.toBe("acquired");
		child.kill("SIGKILL");
		await childExit(child);

		const recovered = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it("admits exactly one real process when two contenders recover the same stale owner", async () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: 2_147_480_000,
			token: "dead-owner-for-race",
			project,
			createdAt: new Date().toISOString(),
		});
		const goPath = join(root, "go");
		const first = spawnRacingContender(root, goPath);
		const second = spawnRacingContender(root, goPath);
		await Promise.all([first.ready, second.ready]);
		writeFileSync(goPath, "go", { flag: "wx" });
		const outcomes = await Promise.all([first.result, second.result]);
		expect(outcomes.filter((outcome) => outcome === "acquired")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome === "busy")).toHaveLength(1);
		await Promise.all([childExit(first.child), childExit(second.child)]);
	});

	it("does not retire a successor that replaces the owner after stale observation", () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: 2_147_480_000,
			token: "observed-stale-owner",
			project,
			createdAt: new Date().toISOString(),
		});
		const path = compilerLockPath(root);
		const successorToken = "live-successor";
		const lease = tryAcquireCrossProcessCompilerLease(project, {
			beforeRetireObserved: () => {
				rmSync(path, { recursive: true, force: true });
				writeSyntheticOwner(root, {
					pid: process.pid,
					token: successorToken,
					project,
					createdAt: new Date().toISOString(),
				});
			},
		});
		expect(lease).toBeNull();
		expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf-8"))).toMatchObject({
			token: successorToken,
			pid: process.pid,
		});
	});

	it("releases the mutation fence when stale-retirement inspection throws", () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: 2_147_480_000,
			token: "stale-owner-before-throw",
			project,
			createdAt: new Date().toISOString(),
		});
		expect(() =>
			tryAcquireCrossProcessCompilerLease(project, {
				beforeRetireObserved: () => {
					throw new Error("injected stale inspection failure");
				},
			}),
		).toThrow("injected stale inspection failure");
		const recovered = tryAcquireCrossProcessCompilerLease(project);
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"persists a process-start identity and reclaims a live reused PID with a different identity",
		() => {
			const project = canonicalProjectRoot(root);
			writeSyntheticOwner(root, {
				pid: process.pid,
				token: "owner-from-an-exited-process",
				project,
				createdAt: new Date().toISOString(),
				processIdentity: "not-the-current-process-start",
			});

			const recovered = tryAcquireCrossProcessCompilerLease(project);
			expect(recovered).not.toBeNull();
			expect(readFileSync(join(compilerLockPath(root), "owner.json"), "utf-8")).toContain(
				'"processIdentity":',
			);
			recovered?.release();
		},
	);

	it("keeps a fresh legacy owner with a live PID for backward compatibility", () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: process.pid,
			token: "legacy-live-owner",
			project,
			createdAt: new Date().toISOString(),
		});

		expect(tryAcquireCrossProcessCompilerLease(project)).toBeNull();
	});

	it("reclaims an over-age legacy owner even when its PID is live", () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: process.pid,
			token: "legacy-reused-owner",
			project,
			createdAt: new Date(Date.now() - PROJECT_LEASE_HARD_MAX_AGE_MS - 1).toISOString(),
		});

		const recovered = tryAcquireCrossProcessCompilerLease(project);
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it("does not reclaim fresh malformed owner metadata while another process initializes it", () => {
		const path = compilerLockPath(root);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "owner.json"), '{"pid":');

		expect(tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root))).toBeNull();
	});

	it("reclaims malformed owner metadata after the initialization grace expires", () => {
		const path = compilerLockPath(root);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "owner.json"), '{"pid":');
		const stale = new Date(Date.now() - 6_000);
		utimesSync(path, stale, stale);

		const recovered = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it("treats a malformed process identity as malformed owner metadata", () => {
		const path = compilerLockPath(root);
		writeSyntheticOwner(root, {
			pid: process.pid,
			token: "invalid-identity-owner",
			project: canonicalProjectRoot(root),
			createdAt: new Date().toISOString(),
			processIdentity: 42,
		});
		const stale = new Date(Date.now() - 6_000);
		utimesSync(path, stale, stale);

		const recovered = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it("allows different project roots concurrently", () => {
		const first = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		const secondRoot = mkdtempSync(join(tmpdir(), "interlinked-compiler-lock-other-"));
		const second = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(secondRoot));
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		first?.release();
		second?.release();
		rmSync(secondRoot, { recursive: true, force: true });
	});
});
