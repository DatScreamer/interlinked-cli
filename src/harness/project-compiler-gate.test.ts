import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import {
	canonicalProjectRoot,
	tryAcquireCrossProcessCompilerLease,
} from "./project-compiler-lock.js";
import {
	ProjectCompilerUnavailableError,
	runWithProjectCompilerLease,
	tryAcquireProjectCompilerLease,
	tryRegisterWarmProjectCompiler,
} from "./project-compiler-gate.js";

describe("project compiler admission", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-compiler-gate-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function waitUntil(predicate: () => boolean, maxAttempts = 100): Promise<void> {
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (predicate()) return;
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 2));
		}
		throw new Error("condition did not become true");
	}

	it("serializes cold compiler work without reusing a stale in-flight result", async () => {
		const events: string[] = [];
		let releaseFirst = (): void => undefined;
		const firstBarrier = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = runWithProjectCompilerLease(root, async () => {
			events.push("first:start");
			await firstBarrier;
			events.push("first:end");
			return "generation-1";
		});
		const second = runWithProjectCompilerLease(root, async () => {
			events.push("second:start");
			return "generation-2";
		});
		await waitUntil(() => events.length > 0);
		expect(events).toEqual(["first:start"]);
		releaseFirst();
		await expect(Promise.all([first, second])).resolves.toEqual(["generation-1", "generation-2"]);
		expect(events).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("allows different projects to compile concurrently", async () => {
		let active = 0;
		let peak = 0;
		const task = async (): Promise<void> => {
			active++;
			peak = Math.max(peak, active);
			await Promise.resolve();
			active--;
		};
		await Promise.all([
			runWithProjectCompilerLease(join(root, "a"), task),
			runWithProjectCompilerLease(join(root, "b"), task),
		]);
		expect(peak).toBe(2);
	});

	it("waits for warm child exit before starting cold work", async () => {
		let reportExited = (): void => undefined;
		const exited = new Promise<void>((resolveExit) => {
			reportExited = resolveExit;
		});
		let unregister: (() => void) | null = null;
		const evict = vi.fn(async () => {
			await exited;
			unregister?.();
		});
		unregister = tryRegisterWarmProjectCompiler(root, evict);
		expect(unregister).not.toBeNull();
		let coldStarted = false;
		const cold = runWithProjectCompilerLease(root, async () => {
			coldStarted = true;
		});
		await waitUntil(() => evict.mock.calls.length === 1);
		expect(coldStarted).toBe(false);
		expect(tryAcquireProjectCompilerLease(root)).toBeNull();
		reportExited();
		await cold;
		expect(coldStarted).toBe(true);
		await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 0));
		const release = tryAcquireProjectCompilerLease(root);
		expect(release).not.toBeNull();
		release?.();
	});

	it("bounds admission when a warm compiler never acknowledges eviction", async () => {
		const neverExits = new Promise<void>(() => undefined);
		const unregister = tryRegisterWarmProjectCompiler(root, () => neverExits);
		expect(unregister).not.toBeNull();
		const startedAt = Date.now();
		await expect(
			runWithProjectCompilerLease(root, async () => "must-not-run", {
				admissionTimeoutMs: 25,
			}),
		).rejects.toMatchObject({
			name: "ProjectCompilerUnavailableError",
			reason: "busy",
			message: "warm compiler eviction exceeded the admission deadline",
		});
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		unregister?.();
		const release = tryAcquireProjectCompilerLease(root);
		expect(release).not.toBeNull();
		release?.();
	});

	it("makes a contended synchronous caller defer", async () => {
		let release = (): void => undefined;
		let activeStarted = false;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const active = runWithProjectCompilerLease(root, () => {
			activeStarted = true;
			return barrier;
		});
		await waitUntil(() => activeStarted);
		expect(tryAcquireProjectCompilerLease(root)).toBeNull();
		release();
		await active;
	});

	it("queues asynchronous work behind an active synchronous lease", async () => {
		const release = tryAcquireProjectCompilerLease(root);
		expect(release).not.toBeNull();
		const events: string[] = [];
		const queued = runWithProjectCompilerLease(root, async () => {
			events.push("async:start");
		});
		await Promise.resolve();
		expect(events).toEqual([]);
		release?.();
		await queued;
		expect(events).toEqual(["async:start"]);
	});

	it("bounds and cancels queued compiler work", async () => {
		let releaseActive = (): void => undefined;
		const barrier = new Promise<void>((resolveBarrier) => {
			releaseActive = resolveBarrier;
		});
		let activeStarted = false;
		const active = runWithProjectCompilerLease(root, async () => {
			activeStarted = true;
			await barrier;
		});
		await waitUntil(() => activeStarted);

		const controller = new AbortController();
		let queuedStarted = false;
		const queued = runWithProjectCompilerLease(
			root,
			async () => {
				queuedStarted = true;
			},
			{ signal: controller.signal, maxQueued: 1, admissionTimeoutMs: 5_000 },
		);
		const overflow = runWithProjectCompilerLease(root, async () => undefined, {
			maxQueued: 1,
		});
		await expect(overflow).rejects.toMatchObject({ reason: "queue_full" });
		controller.abort();
		await expect(queued).rejects.toMatchObject({ reason: "aborted" });
		expect(queuedStarted).toBe(false);
		releaseActive();
		await active;
	});

	it("reports a typed abort while waiting on a different process owner", async () => {
		const externalLease = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(externalLease).not.toBeNull();
		const controller = new AbortController();
		try {
			const pending = runWithProjectCompilerLease(root, async () => "never", {
				signal: controller.signal,
				admissionTimeoutMs: 5_000,
			});
			controller.abort();
			await expect(pending).rejects.toMatchObject({
				name: "ProjectCompilerUnavailableError",
				reason: "aborted",
				cause: expect.objectContaining({ message: "compiler admission aborted" }),
			});
		} finally {
			externalLease?.release();
		}
	});

	it("holds admission until a timed-out wrapper and its TERM-resistant child are gone", async () => {
		const childPidPath = join(root, "child.pid");
		const childTermPath = join(root, "child.term");
		const wrapperTermPath = join(root, "wrapper.term");
		const wrapperProgram = [
			'const { spawn } = require("node:child_process");',
			'const fs = require("node:fs");',
			"const [pidPath, childTermPath, wrapperTermPath] = process.argv.slice(1);",
			"process.on('SIGTERM', () => { fs.writeFileSync(wrapperTermPath, 'term'); process.exit(0); });",
			"const child = spawn(process.execPath, ['-e', \"const fs=require('node:fs'); const p=process.argv[1]; process.on('SIGTERM',()=>fs.writeFileSync(p,'term')); setInterval(()=>{},1000);\", childTermPath], { stdio: 'ignore' });",
			"fs.writeFileSync(pidPath, String(child.pid));",
			"setInterval(() => {}, 1000);",
		].join(" ");
		let childPid = 0;
		try {
			const owner = runWithProjectCompilerLease(root, () =>
				runProcessAsync(
					process.execPath,
					["-e", wrapperProgram, childPidPath, childTermPath, wrapperTermPath],
					{ timeout: 100 },
				),
			);
			await waitUntil(() => existsSync(childPidPath), 1_000);
			childPid = Number.parseInt(readFileSync(childPidPath, "utf-8"), 10);
			expect(Number.isSafeInteger(childPid)).toBe(true);

			let queuedStarted = false;
			const queued = runWithProjectCompilerLease(root, async () => {
				queuedStarted = true;
			});
			await waitUntil(() => existsSync(wrapperTermPath) && existsSync(childTermPath), 1_000);
			expect(queuedStarted).toBe(false);
			expect(() => process.kill(childPid, 0)).not.toThrow();

			const result = await owner;
			expect(result).toMatchObject({ timedOut: true, killed: true });
			await queued;
			expect(queuedStarted).toBe(true);
			expect(() => process.kill(childPid, 0)).toThrow();
		} finally {
			if (childPid > 0) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					// Already reaped by the process-group termination under test.
					void 0;
				}
			}
		}
	}, 10_000);

	it("canonicalizes symlink aliases onto one project slot", () => {
		const alias = `${root}-alias`;
		symlinkSync(root, alias);
		try {
			const release = tryAcquireProjectCompilerLease(root);
			expect(release).not.toBeNull();
			expect(tryAcquireProjectCompilerLease(alias)).toBeNull();
			release?.();
			const aliasRelease = tryAcquireProjectCompilerLease(alias);
			expect(aliasRelease).not.toBeNull();
			aliasRelease?.();
		} finally {
			rmSync(alias, { force: true });
		}
	});

	it("exposes typed busy failures", () => {
		const error = new ProjectCompilerUnavailableError("busy", "held");
		expect(error).toMatchObject({ name: "ProjectCompilerUnavailableError", reason: "busy" });
	});
});
