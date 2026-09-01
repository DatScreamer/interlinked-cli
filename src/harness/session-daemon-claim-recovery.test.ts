import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimSessionPid } from "./session-daemon.js";

const fsState = vi.hoisted<{
	files: Map<string, string>;
	pidPath: string;
	lockPath: string;
	quarantinePath: string;
	staleRaw: string;
	liveRaw: string;
	renameCalls: Array<[string, string]>;
	removeCalls: string[];
}>(() => ({
	files: new Map<string, string>(),
	pidPath: "",
	lockPath: "",
	quarantinePath: "",
	staleRaw: "",
	liveRaw: "",
	renameCalls: [],
	removeCalls: [],
}));

function errno(message: string, code: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: string) => fsState.files.has(path),
		readFileSync: (path: string, _encoding: string) => {
			const value = fsState.files.get(path);
			if (value === undefined) throw errno(`ENOENT: ${path}`, "ENOENT");
			return value;
		},
		writeFileSync: (path: string, data: string, options?: { flag?: string }) => {
			if (options?.flag === "wx" && fsState.files.has(path)) {
				throw errno(`EEXIST: ${path}`, "EEXIST");
			}
			fsState.files.set(path, data);
		},
		renameSync: (from: string, to: string) => {
			fsState.renameCalls.push([from, to]);
			if (from === fsState.lockPath && to.includes(".stale")) {
				// A live contender replaces the stale lock after our observation but
				// before rename. Recovery must not erase this moved live record.
				fsState.files.set(from, fsState.liveRaw);
				fsState.quarantinePath = to;
			}
			if (from === fsState.quarantinePath && to === fsState.lockPath) {
				throw errno("simulated restore I/O failure", "EIO");
			}
			const value = fsState.files.get(from);
			if (value === undefined) throw errno(`ENOENT: ${from}`, "ENOENT");
			fsState.files.set(to, value);
			fsState.files.delete(from);
		},
		rmSync: (path: string) => {
			fsState.removeCalls.push(path);
			fsState.files.delete(path);
		},
	};
});

describe("claimSessionPid — failed raced-lock restoration", () => {
	beforeEach(() => {
		fsState.files.clear();
		fsState.renameCalls.length = 0;
		fsState.removeCalls.length = 0;
		fsState.pidPath = "/virtual/session.pid";
		fsState.lockPath = `${fsState.pidPath}.claim`;
		fsState.staleRaw = `${JSON.stringify({ pid: 2147480000, token: "stale" })}\n`;
		fsState.liveRaw = `${JSON.stringify({ pid: process.pid, token: "live-racer" })}\n`;
		fsState.files.set(fsState.pidPath, "41");
		fsState.files.set(fsState.lockPath, fsState.staleRaw);
	});

	it("preserves the moved live-owner bytes and leaves the PID untouched on non-EEXIST failure", () => {
		expect(() => claimSessionPid(fsState.pidPath, 42)).toThrow("simulated restore I/O failure");
		expect(fsState.files.get(fsState.pidPath)).toBe("41");
		expect(fsState.files.get(fsState.quarantinePath)).toBe(fsState.liveRaw);
		expect(fsState.removeCalls).not.toContain(fsState.quarantinePath);
		expect(fsState.renameCalls).not.toContainEqual([expect.any(String), fsState.pidPath]);
	});
});
