import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	fileMutationLockPath,
	fileMutationLockOwnerPath,
	withFileMutationLock,
} from "../file-mutation-lock.js";
import { readFileMutationProcessIdentity } from "../file-mutation-lock-identity.js";
import { buildHookScript } from "../hooks-template.js";
import { nonNull } from "../non-null.js";

const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface HookFixture {
	root: string;
	dataDir: string;
	scriptPath: string;
}

interface RunningHook {
	child: ChildProcess;
	completed: Promise<{ status: number | null; stdout: string; stderr: string }>;
}

function sleepSync(ms: number): void {
	Atomics.wait(SLEEP_WORD, 0, 0, ms);
}

function makeFixture(): HookFixture {
	const root = mkdtempSync(join(tmpdir(), "interlinked-hook-lock-"));
	const dataDir = join(root, ".interlinked");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(dataDir, "config.local.json"),
		JSON.stringify({ sync_mode: "local", agent_name: "lock-parity-test" }),
	);
	// Keep the test on the read-only fast path; the placeholder socket prevents
	// cold recovery from spawning a daemon outside the fixture.
	writeFileSync(join(dataDir, "harness.pid"), String(process.pid));
	writeFileSync(join(dataDir, "harness.sock"), "");
	const scriptPath = join(root, "hook.mjs");
	writeFileSync(scriptPath, buildHookScript("file-mutation-lock-test"));
	return { root, dataDir, scriptPath };
}

function readPayload(fixture: HookFixture, sessionId: string): string {
	return JSON.stringify({
		hook_event_name: "PostToolUse",
		session_id: sessionId,
		cwd: fixture.root,
		tool_name: "Read",
		tool_input: { file_path: join(fixture.root, "README.md") },
		tool_response: { content: "fixture" },
	});
}

function startHook(fixture: HookFixture, sessionId: string): RunningHook {
	const inputPath = join(fixture.root, `${sessionId}.stdin.json`);
	const stdoutPath = join(fixture.root, `${sessionId}.stdout.txt`);
	const stderrPath = join(fixture.root, `${sessionId}.stderr.txt`);
	writeFileSync(inputPath, readPayload(fixture, sessionId));
	const inputFd = openSync(inputPath, "r");
	const stdoutFd = openSync(stdoutPath, "w");
	const stderrFd = openSync(stderrPath, "w");
	const child = spawn(process.execPath, [fixture.scriptPath], {
		cwd: fixture.root,
		env: {
			...process.env,
			INTERLINKED_CLIENT: "claude",
			INTERLINKED_DATA_DIR: fixture.dataDir,
			INTERLINKED_HOME: fixture.dataDir,
		},
		stdio: [inputFd, stdoutFd, stderrFd],
	});
	closeSync(inputFd);
	closeSync(stdoutFd);
	closeSync(stderrFd);
	const completed = new Promise<{ status: number | null; stdout: string; stderr: string }>(
		(resolve, reject) => {
			child.once("error", reject);
			child.once("close", (status) =>
				resolve({
					status,
					stdout: readFileSync(stdoutPath, "utf8"),
					stderr: readFileSync(stderrPath, "utf8"),
				}),
			);
		},
	);
	return { child, completed };
}

function waitSynchronouslyFor(path: string, timeoutMs = 3_000): void {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path) && Date.now() < deadline) sleepSync(5);
	expect(existsSync(path), `timed out waiting for ${path}`).toBe(true);
}

function runHook(fixture: HookFixture, sessionId: string) {
	return spawnSync(process.execPath, [fixture.scriptPath], {
		cwd: fixture.root,
		env: {
			...process.env,
			INTERLINKED_CLIENT: "claude",
			INTERLINKED_DATA_DIR: fixture.dataDir,
			INTERLINKED_HOME: fixture.dataDir,
		},
		input: readPayload(fixture, sessionId),
		encoding: "utf8",
		timeout: 10_000,
	});
}

async function startIdentityFixtureProcess(): Promise<ChildProcess> {
	const child = spawn(
		process.execPath,
		["--eval", "process.stdout.write('ready');setInterval(()=>{},1000)"],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	await once(child.stdout, "data");
	return child;
}

describe("generated hook file-mutation lock parity", () => {
	it("waits for the CLI activity lock instead of appending around it", async () => {
		const fixture = makeFixture();
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const receiptPath = join(fixture.dataDir, "hook-runtime.json");
		const holder: { running?: RunningHook } = {};

		withFileMutationLock(activityPath, () => {
			const lockPath = fileMutationLockPath(activityPath);
			const ownerEntry = nonNull(readdirSync(lockPath)[0]);
			const owner = JSON.parse(readFileSync(join(lockPath, ownerEntry), "utf8"));
			expect(owner.boot_id).toMatch(/^(darwin|linux):/);
			expect(owner.process_start_id).toMatch(/^(darwin|linux):/);
			holder.running = startHook(fixture, "activity-lock-wait");
			waitSynchronouslyFor(receiptPath);
			// The receipt is written before appendLocal. Give the generated hook
			// ample time to reach the held production lock, then prove it neither
			// bypassed the lock nor exited after silently dropping the record.
			sleepSync(150);
			expect(existsSync(activityPath)).toBe(false);
			expect(holder.running.child.exitCode).toBeNull();
		});

		const running = nonNull(holder.running);
		const result = await running.completed;
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(activityPath, "utf8")).toContain("activity-lock-wait");
		expect(existsSync(fileMutationLockPath(activityPath))).toBe(false);
	});

	it("waits for the CLI collection lock after recording activity", async () => {
		const fixture = makeFixture();
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const collectionPath = join(fixture.dataDir, "collection.jsonl");
		const holder: { running?: RunningHook } = {};

		withFileMutationLock(collectionPath, () => {
			holder.running = startHook(fixture, "collection-lock-wait");
			waitSynchronouslyFor(activityPath);
			sleepSync(50);
			expect(existsSync(collectionPath)).toBe(false);
			expect(holder.running.child.exitCode).toBeNull();
		});

		const running = nonNull(holder.running);
		const result = await running.completed;
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(collectionPath, "utf8")).toContain("collection-lock-wait");
		expect(existsSync(fileMutationLockPath(collectionPath))).toBe(false);
	});

	it("recovers a dead canonical owner without leaving its lock behind", () => {
		const fixture = makeFixture();
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const lockPath = fileMutationLockPath(activityPath);
		mkdirSync(lockPath);
		writeFileSync(
			fileMutationLockOwnerPath(activityPath, "dead-owner"),
			JSON.stringify({
				pid: 2_147_483_647,
				token: "dead-owner",
				acquired_at_ms: 1,
			}),
			{ flag: "wx" },
		);

		const result = runHook(fixture, "dead-owner-recovery");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(activityPath, "utf8")).toContain("dead-owner-recovery");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers a pre-reboot owner whose PID was reused by a live process", () => {
		const fixture = makeFixture();
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const lockPath = fileMutationLockPath(activityPath);
		mkdirSync(lockPath);
		writeFileSync(
			fileMutationLockOwnerPath(activityPath, "pre-reboot-live-pid"),
			JSON.stringify({
				pid: process.pid,
				token: "pre-reboot-live-pid",
				acquired_at_ms: 1,
				boot_id: "foreign-boot-before-restart",
				process_start_id: "foreign-process-before-restart",
			}),
			{ flag: "wx" },
		);

		const result = runHook(fixture, "pre-reboot-live-pid-recovery");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(activityPath, "utf8")).toContain("pre-reboot-live-pid-recovery");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers same-boot PID reuse using the source writer's identity record", () => {
		const fixture = makeFixture();
		const probePath = join(fixture.dataDir, "identity-probe.jsonl");
		let currentOwner: Record<string, unknown> | undefined;
		withFileMutationLock(probePath, () => {
			const probeLock = fileMutationLockPath(probePath);
			const entry = nonNull(readdirSync(probeLock)[0]);
			currentOwner = JSON.parse(readFileSync(join(probeLock, entry), "utf8"));
		});
		const acquiredAtMs = Number(currentOwner?.acquired_at_ms);
		expect(Number.isSafeInteger(acquiredAtMs)).toBe(true);
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const lockPath = fileMutationLockPath(activityPath);
		mkdirSync(lockPath);
		writeFileSync(
			fileMutationLockOwnerPath(activityPath, "same-boot-reused-pid"),
			JSON.stringify({
				pid: process.pid,
				token: "same-boot-reused-pid",
				acquired_at_ms: acquiredAtMs,
				boot_id: currentOwner?.boot_id,
				process_start_id: "different-process-start",
			}),
			{ flag: "wx" },
		);

		const result = runHook(fixture, "same-boot-reused-pid-recovery");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(activityPath, "utf8")).toContain("same-boot-reused-pid-recovery");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers a pre-identity live-PID record proven to predate this boot", () => {
		const fixture = makeFixture();
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const lockPath = fileMutationLockPath(activityPath);
		mkdirSync(lockPath);
		writeFileSync(
			fileMutationLockOwnerPath(activityPath, "legacy-prior-boot"),
			JSON.stringify({ pid: process.pid, token: "legacy-prior-boot", acquired_at_ms: 1 }),
			{ flag: "wx" },
		);

		const result = runHook(fixture, "legacy-prior-boot-recovery");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(activityPath, "utf8")).toContain("legacy-prior-boot-recovery");
		expect(existsSync(lockPath)).toBe(false);
	});

	it.runIf(process.platform === "linux" || process.platform === "darwin")(
		"recovers same-boot PID reuse from a legacy owner on supported platforms",
		{ timeout: 15_000 },
		async () => {
			const fixture = makeFixture();
			const child = spawn(process.execPath, ["--eval", "process.stdout.write('ready');setInterval(()=>{},1000)"] , {
				stdio: ["ignore", "pipe", "ignore"],
			});
			await once(child.stdout, "data");
			try {
				const activityPath = join(fixture.dataDir, "activity.jsonl");
				const lockPath = fileMutationLockPath(activityPath);
				mkdirSync(lockPath);
				writeFileSync(
					fileMutationLockOwnerPath(activityPath, "legacy-same-boot-reuse"),
					JSON.stringify({
						pid: child.pid,
						token: "legacy-same-boot-reuse",
						acquired_at_ms: Date.now() - 5_000,
					}),
					{ flag: "wx" },
				);
				const result = runHook(fixture, "legacy-same-boot-reuse-recovery");
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
				expect(readFileSync(activityPath, "utf8")).toContain(
					"legacy-same-boot-reuse-recovery",
				);
			} finally {
				child.kill();
			}
		},
	);

	it.runIf(process.platform === "linux" || process.platform === "darwin")(
		"recovers same-boot PID reuse from a boot-only owner",
		{ timeout: 15_000 },
		async () => {
			const fixture = makeFixture();
			const child = await startIdentityFixtureProcess();
			try {
				const pid = nonNull(child.pid);
				const identity = readFileMutationProcessIdentity(pid, 50_000);
				const startedAtMs = nonNull(identity.processStartedAtMs);
				const activityPath = join(fixture.dataDir, "activity.jsonl");
				const lockPath = fileMutationLockPath(activityPath);
				mkdirSync(lockPath);
				writeFileSync(
					fileMutationLockOwnerPath(activityPath, "boot-only-reused-pid"),
					JSON.stringify({
						pid,
						token: "boot-only-reused-pid",
						acquired_at_ms: startedAtMs - 5_000,
						boot_id: identity.bootId,
					}),
					{ flag: "wx" },
				);
				const result = runHook(fixture, "boot-only-reused-pid-recovery");
				expect(result.status, result.stderr).toBe(0);
				expect(readFileSync(activityPath, "utf8")).toContain(
					"boot-only-reused-pid-recovery",
				);
			} finally {
				child.kill();
			}
		},
	);

	it.runIf(process.platform === "linux" || process.platform === "darwin")(
		"recovers PID reuse from a start-only owner",
		{ timeout: 15_000 },
		async () => {
			const fixture = makeFixture();
			const child = await startIdentityFixtureProcess();
			try {
				const pid = nonNull(child.pid);
				const identity = readFileMutationProcessIdentity(pid, 60_000);
				const startedAtMs = nonNull(identity.processStartedAtMs);
				const activityPath = join(fixture.dataDir, "activity.jsonl");
				const lockPath = fileMutationLockPath(activityPath);
				mkdirSync(lockPath);
				writeFileSync(
					fileMutationLockOwnerPath(activityPath, "start-only-reused-pid"),
					JSON.stringify({
						pid,
						token: "start-only-reused-pid",
						acquired_at_ms: startedAtMs - 5_000,
						process_start_id: identity.processStartId,
					}),
					{ flag: "wx" },
				);
				const result = runHook(fixture, "start-only-reused-pid-recovery");
				expect(result.status, result.stderr).toBe(0);
				expect(readFileSync(activityPath, "utf8")).toContain(
					"start-only-reused-pid-recovery",
				);
			} finally {
				child.kill();
			}
		},
	);

	it("recovers a stale malformed collection lock", () => {
		const fixture = makeFixture();
		const collectionPath = join(fixture.dataDir, "collection.jsonl");
		const lockPath = fileMutationLockPath(collectionPath);
		mkdirSync(lockPath);
		// interlinked: defer write_without_mkdir -- lockPath is created immediately above.
		writeFileSync(join(lockPath, "not-an-owner"), "not-json", { flag: "wx" });
		const old = new Date(0);
		utimesSync(lockPath, old, old);

		const result = runHook(fixture, "malformed-owner-recovery");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(collectionPath, "utf8")).toContain("malformed-owner-recovery");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("treats an invalid-token owner as malformed and recovers it only when stale", () => {
		const fixture = makeFixture();
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const lockPath = fileMutationLockPath(activityPath);
		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "owner-bad token.json"),
			JSON.stringify({ pid: process.pid, token: "bad token", acquired_at_ms: 1 }),
			{ flag: "wx" },
		);
		const old = new Date(0);
		utimesSync(lockPath, old, old);

		const result = runHook(fixture, "invalid-token-owner-recovery");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(activityPath, "utf8")).toContain("invalid-token-owner-recovery");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("never reaps a fresh malformed lock as abandoned", async () => {
		const fixture = makeFixture();
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const lockPath = fileMutationLockPath(activityPath);
		mkdirSync(lockPath);
		const publicationPath = join(lockPath, "publication-in-progress");
		writeFileSync(publicationPath, "publication-in-progress", { flag: "wx" });
		const running = startHook(fixture, "fresh-malformed-waits");
		waitSynchronouslyFor(join(fixture.dataDir, "hook-runtime.json"));
		sleepSync(150);
		expect(readFileSync(publicationPath, "utf8")).toBe("publication-in-progress");
		expect(existsSync(activityPath)).toBe(false);
		expect(running.child.exitCode).toBeNull();

		rmSync(lockPath, { recursive: true });
		const result = await running.completed;
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(activityPath, "utf8")).toContain("fresh-malformed-waits");
	});

	it("recovers the legacy single-file lock during a rolling upgrade", () => {
		const fixture = makeFixture();
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const lockPath = fileMutationLockPath(activityPath);
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 2_147_483_647, token: "legacy-dead", acquired_at_ms: 1 }),
			{ flag: "wx" },
		);

		const result = runHook(fixture, "legacy-lock-recovery");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(activityPath, "utf8")).toContain("legacy-lock-recovery");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers a stale malformed legacy single-file lock", () => {
		const fixture = makeFixture();
		const collectionPath = join(fixture.dataDir, "collection.jsonl");
		const lockPath = fileMutationLockPath(collectionPath);
		writeFileSync(lockPath, "legacy-publication-crashed", { flag: "wx" });
		const old = new Date(0);
		utimesSync(lockPath, old, old);

		const result = runHook(fixture, "legacy-malformed-recovery");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(collectionPath, "utf8")).toContain("legacy-malformed-recovery");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("serializes two generated recoverers without losing a successor", async () => {
		const fixture = makeFixture();
		const activityPath = join(fixture.dataDir, "activity.jsonl");
		const lockPath = fileMutationLockPath(activityPath);
		mkdirSync(lockPath);
		writeFileSync(
			fileMutationLockOwnerPath(activityPath, "dead-race-owner"),
			JSON.stringify({ pid: 2_147_483_647, token: "dead-race-owner", acquired_at_ms: 1 }),
			{ flag: "wx" },
		);

		const first = startHook(fixture, "recoverer-one");
		const second = startHook(fixture, "recoverer-two");
		const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
		expect(firstResult.status, firstResult.stderr).toBe(0);
		expect(secondResult.status, secondResult.stderr).toBe(0);
		const activity = readFileSync(activityPath, "utf8");
		expect(activity).toContain("recoverer-one");
		expect(activity).toContain("recoverer-two");
		expect(existsSync(lockPath)).toBe(false);
	});
});
