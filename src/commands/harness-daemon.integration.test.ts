import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	closeSync: vi.fn(),
	execSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	openSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
	rmSync: vi.fn(),
	spawn: vi.fn(),
	statSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: mocks.execSync,
	spawn: mocks.spawn,
}));

vi.mock("node:fs", () => ({
	closeSync: mocks.closeSync,
	existsSync: mocks.existsSync,
	mkdirSync: mocks.mkdirSync,
	openSync: mocks.openSync,
	readdirSync: mocks.readdirSync,
	readFileSync: mocks.readFileSync,
	rmSync: mocks.rmSync,
	statSync: mocks.statSync,
	unlinkSync: mocks.unlinkSync,
}));

import { nonNull } from "../lib/non-null.js";
import { harnessStartCommand } from "./harness.js";

interface FakeChild extends EventEmitter {
	pid: number;
	unref: ReturnType<typeof vi.fn>;
}

function createFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.pid = 1234;
	child.unref = vi.fn();
	return child;
}

describe("harness start daemon stderr handling", () => {
	beforeEach(() => {
		for (const mock of Object.values(mocks)) mock.mockReset();
		vi.spyOn(process, "cwd").mockReturnValue("/repo");
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		mocks.existsSync.mockImplementation((pathLike: string | Buffer | URL) => {
			const path = String(pathLike);
			if (path === "/repo/.interlinked/harness.pid") return false;
			if (path === "/repo/.interlinked/logs") return false;
			if (path === "/repo/.interlinked/logs/daemon.log") return false;
			if (path === "/repo/.interlinked/harness.sock") return true;
			if (path === "/repo/.interlinked/harness-default.sock") return true;
			return path.includes("/dist/harness/server.js");
		});
		mocks.openSync.mockReturnValue(42);
		mocks.readFileSync.mockReturnValue(Buffer.alloc(0));
		mocks.statSync.mockReturnValue({ size: 0 });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("redirects daemon stderr to a log file instead of a pipe", async () => {
		const child = createFakeChild();
		mocks.spawn.mockReturnValue(child);

		await harnessStartCommand({ daemon: true, verbose: true });

		expect(mocks.openSync).toHaveBeenCalledWith("/repo/.interlinked/logs/daemon.log", "a");
		expect(mocks.closeSync).toHaveBeenCalledWith(42);
		expect(mocks.spawn).toHaveBeenCalledOnce();
		expect(nonNull(mocks.spawn.mock.calls[0])[1]).toEqual(
			expect.arrayContaining(["--protocol", "dual", "--session-id", "default"]),
		);
		expect(nonNull(mocks.spawn.mock.calls[0])[2]).toMatchObject({
			cwd: "/repo",
			detached: true,
			stdio: ["ignore", "ignore", 42],
		});
		expect(child.unref).toHaveBeenCalledOnce();
	});
});
