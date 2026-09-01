import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	rmdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendFileWithMutationLock,
	fileMutationLockPath,
	fileMutationLockOwnerPath,
	FileMutationLockTimeoutError,
	withFileMutationLock,
} from "./file-mutation-lock.js";

describe("file mutation lock", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "file-mutation-lock-"));
		path = join(dir, "activity.jsonl");
		writeFileSync(path, "before\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function seedOwner(pid: number, token: string, acquiredAtMs: number): string {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		const ownerPath = fileMutationLockOwnerPath(path, token);
		writeFileSync(ownerPath, JSON.stringify({ pid, token, acquired_at_ms: acquiredAtMs }));
		return ownerPath;
	}

	const CURRENT_IDENTITY = {
		bootId: "test-boot-current",
		bootStartedAtMs: 10_000,
		processStartId: "test-process-current",
		processStartedAtMs: 20_000,
	};

	function seedIdentifiedOwner(owner: {
		pid: number;
		token: string;
		acquiredAtMs: number;
		bootId: string;
		processStartId: string;
	}): string {
		const ownerPath = seedOwner(owner.pid, owner.token, owner.acquiredAtMs);
		writeFileSync(
			ownerPath,
			JSON.stringify({
				pid: owner.pid,
				token: owner.token,
				acquired_at_ms: owner.acquiredAtMs,
				boot_id: owner.bootId,
				process_start_id: owner.processStartId,
			}),
		);
		return ownerPath;
	}

	it("serializes an append and releases its PID/token owner record", () => {
		appendFileWithMutationLock(path, "after\n");
		expect(readFileSync(path, "utf8")).toBe("before\nafter\n");
		expect(existsSync(fileMutationLockPath(path))).toBe(false);
	});

	it("publishes boot and process-start identity with a live owner", () => {
		withFileMutationLock(path, () => {
			const lockPath = fileMutationLockPath(path);
			const entry = readdirSync(lockPath)[0];
			expect(entry).toBeDefined();
			const owner = JSON.parse(readFileSync(join(lockPath, entry ?? ""), "utf8"));
			expect(owner.boot_id).toMatch(/^(darwin|linux):/);
			expect(owner.process_start_id).toMatch(/^(darwin|linux):/);
		});
	});

	it("recovers a pre-reboot lock even when its PID now belongs to a live process", () => {
		seedIdentifiedOwner({
			pid: process.pid,
			token: "pre-reboot-owner",
			acquiredAtMs: 1,
			bootId: "test-boot-before-restart",
			processStartId: "test-process-before-restart",
		});
		appendFileWithMutationLock(path, "after-reboot\n", {
			waitMs: 50,
			identityProvider: () => CURRENT_IDENTITY,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nafter-reboot\n");
	});

	it("recovers same-boot PID reuse from a changed process-start identity", () => {
		seedIdentifiedOwner({
			pid: process.pid,
			token: "reused-pid-owner",
			acquiredAtMs: 25_000,
			bootId: CURRENT_IDENTITY.bootId,
			processStartId: "test-process-before-reuse",
		});
		appendFileWithMutationLock(path, "after-reuse\n", {
			waitMs: 50,
			identityProvider: () => CURRENT_IDENTITY,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nafter-reuse\n");
	});

	it("recovers PID reuse from a matching boot-only owner record", () => {
		const ownerPath = seedOwner(process.pid, "boot-only-owner", 10_000);
		writeFileSync(
			ownerPath,
			JSON.stringify({
				pid: process.pid,
				token: "boot-only-owner",
				acquired_at_ms: 10_000,
				boot_id: CURRENT_IDENTITY.bootId,
			}),
		);
		appendFileWithMutationLock(path, "boot-only-recovered\n", {
			waitMs: 50,
			identityProvider: () => ({
				...CURRENT_IDENTITY,
				bootStartedAtMs: 1,
				processStartedAtMs: 20_000,
			}),
		});
		expect(readFileSync(path, "utf8")).toBe("before\nboot-only-recovered\n");
	});

	it("recovers a start-only record whose boot-relative id was reused later", () => {
		const ownerPath = seedOwner(process.pid, "start-only-owner", 10_000);
		writeFileSync(
			ownerPath,
			JSON.stringify({
				pid: process.pid,
				token: "start-only-owner",
				acquired_at_ms: 10_000,
				process_start_id: CURRENT_IDENTITY.processStartId,
			}),
		);
		appendFileWithMutationLock(path, "start-only-recovered\n", {
			waitMs: 50,
			identityProvider: () => ({
				...CURRENT_IDENTITY,
				bootStartedAtMs: 20_000,
				processStartedAtMs: 20_000,
			}),
		});
		expect(readFileSync(path, "utf8")).toBe("before\nstart-only-recovered\n");
	});

	it("never reaps a genuinely live owner with matching identity", () => {
		seedIdentifiedOwner({
			pid: process.pid,
			token: "live-identified-owner",
			acquiredAtMs: 25_000,
			bootId: CURRENT_IDENTITY.bootId,
			processStartId: CURRENT_IDENTITY.processStartId,
		});
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				clock: () => 25_001,
				identityProvider: () => CURRENT_IDENTITY,
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("protects a live identity-bearing owner when the OS probe is unavailable", () => {
		seedIdentifiedOwner({
			pid: process.pid,
			token: "live-owner-probe-unavailable",
			acquiredAtMs: 25_000,
			bootId: CURRENT_IDENTITY.bootId,
			processStartId: CURRENT_IDENTITY.processStartId,
		});
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				clock: () => 25_001,
				identityProvider: () => {
					throw new Error("identity unavailable");
				},
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("recovers a pre-identity legacy record proven to predate this boot", () => {
		seedOwner(process.pid, "legacy-prior-boot", 1);
		appendFileWithMutationLock(path, "legacy-recovered\n", {
			waitMs: 50,
			identityProvider: () => CURRENT_IDENTITY,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nlegacy-recovered\n");
	});

	it("recovers same-boot PID reuse for a pre-identity Linux-style record", () => {
		seedOwner(process.pid, "legacy-same-boot-reuse", 10_000);
		appendFileWithMutationLock(path, "legacy-same-boot-recovered\n", {
			waitMs: 50,
			identityProvider: () => ({
				...CURRENT_IDENTITY,
				bootStartedAtMs: 1,
				processStartedAtMs: 20_000,
			}),
		});
		expect(readFileSync(path, "utf8")).toBe("before\nlegacy-same-boot-recovered\n");
	});

	it("protects an ambiguous live legacy owner when identity is unavailable", () => {
		seedOwner(process.pid, "legacy-live-unknown", 25_000);
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				clock: () => 25_001,
				identityProvider: () => ({
					bootId: null,
					bootStartedAtMs: null,
					processStartId: null,
					processStartedAtMs: null,
				}),
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("never bypasses a held lock when append contention times out", () => {
		expect(() =>
			withFileMutationLock(path, () => {
				appendFileWithMutationLock(path, "lost\n", { waitMs: 0 });
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("recovers a lock whose recorded owner process is dead", () => {
		seedOwner(2_147_483_647, "dead-owner", 1);
		appendFileWithMutationLock(path, "recovered\n", { waitMs: 50 });
		expect(readFileSync(path, "utf8")).toBe("before\nrecovered\n");
	});

	it("recovers dead and stale legacy single-file locks during rolling upgrade", () => {
		const lockPath = fileMutationLockPath(path);
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 2_147_483_647, token: "legacy-dead", acquired_at_ms: 1 }),
		);
		appendFileWithMutationLock(path, "after-dead\n", { waitMs: 50 });

		writeFileSync(lockPath, "legacy-malformed");
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		appendFileWithMutationLock(path, "after-stale\n", {
			waitMs: 50,
			staleMs: 10,
			clock: () => 20_000,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nafter-dead\nafter-stale\n");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers an old malformed lock but does not treat a fresh one as abandoned", () => {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "not-an-owner"), "not-json");
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		appendFileWithMutationLock(path, "recovered\n", {
			waitMs: 50,
			staleMs: 10,
			clock: () => 20_000,
		});
		expect(readFileSync(path, "utf8")).toContain("recovered");

		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "still-publishing"), "not-json");
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				staleMs: 60_000,
				clock: () => 20_001,
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).not.toContain("bypassed");
	});

	it("treats an invalid-token owner record as malformed and recovers it only when stale", () => {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "owner-bad token.json"),
			JSON.stringify({ pid: process.pid, token: "bad token", acquired_at_ms: 1 }),
		);
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		appendFileWithMutationLock(path, "invalid-token-recovered\n", {
			waitMs: 50,
			staleMs: 10,
			clock: () => 20_000,
		});
		expect(readFileSync(path, "utf8")).toContain("invalid-token-recovered");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("does not require the target to exist before the first append", () => {
		const freshDir = join(dir, "nested");
		mkdirSync(freshDir);
		const fresh = join(freshDir, "collection.jsonl");
		appendFileWithMutationLock(fresh, "first\n");
		expect(readFileSync(fresh, "utf8")).toBe("first\n");
	});

	it("serializes a real child-process writer instead of letting it append around contention", async () => {
		const lockPath = fileMutationLockPath(path);
		const ownerPath = seedOwner(process.pid, "parent-owner", Date.now());
		const moduleUrl = new URL("./file-mutation-lock.ts", import.meta.url).href;
		const source = [
			`import { appendFileWithMutationLock } from ${JSON.stringify(moduleUrl)};`,
			`process.stdout.write("ready\\n");`,
			`appendFileWithMutationLock(process.env.INTERLINKED_TEST_TARGET, "child\\n", { waitMs: 2000 });`,
		].join("\n");
		const child = spawn(process.execPath, ["--import", "tsx", "--eval", source], {
			env: { ...process.env, INTERLINKED_TEST_TARGET: path },
			stdio: ["ignore", "pipe", "pipe"],
		});
		await once(child.stdout, "data");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(readFileSync(path, "utf8")).toBe("before\n");
		rmSync(ownerPath);
		rmdirSync(lockPath);
		const [exitCode] = await once(child, "exit");
		expect(exitCode).toBe(0);
		expect(readFileSync(path, "utf8")).toBe("before\nchild\n");
	});

	it("a stale second recoverer cannot unlink the live successor acquired by the first", () => {
		const lockPath = fileMutationLockPath(path);
		const deadOwner = seedOwner(2_147_483_647, "dead-race-owner", 1);
		const successor = fileMutationLockOwnerPath(path, "successor-owner");

		expect(() =>
			appendFileWithMutationLock(path, "overlap\n", {
				waitMs: 0,
				beforeRetireObserved: () => {
					// Recoverer A retires the exact dead token and acquires its own
					// directory before recoverer B acts on its stale observation.
					rmSync(deadOwner);
					rmdirSync(lockPath);
					mkdirSync(lockPath);
					writeFileSync(
						successor,
						JSON.stringify({
							pid: process.pid,
							token: "successor-owner",
							acquired_at_ms: Date.now(),
						}),
					);
				},
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(successor, "utf8")).toContain("successor-owner");
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});
});
