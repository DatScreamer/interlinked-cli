import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint } from "../checkpoints.js";

// Mock dependencies
vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

vi.mock("node:crypto", () => ({
	randomBytes: vi.fn(() => Buffer.from("abcdef123456", "hex")),
}));

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	archiveCheckpoints,
	compareCheckpoints,
	createCheckpoint,
	getCheckpoint,
	listCheckpoints,
	pruneCheckpoints,
	shouldAutoCheckpoint,
} from "../checkpoints.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createCheckpoint", () => {
	it("creates a checkpoint with stash", () => {
		// Mock git commands
		mockExecSync
			.mockReturnValueOnce("ok") // rev-parse --git-dir
			.mockReturnValueOnce("abc123\n") // rev-parse HEAD
			.mockReturnValueOnce("src/index.ts\nsrc/lib/config.ts\n") // diff --name-only
			.mockReturnValueOnce("") // ls-files --others
			.mockReturnValueOnce("") // stash push
			.mockReturnValueOnce("deadbeef\n") // stash list -1
			.mockReturnValueOnce(""); // stash pop

		// Mock checkpoints file
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			if (String(path).includes("checkpoints.json")) return false;
			if (String(path).includes("config.local.json")) return false;
			return true;
		});

		const cp = createCheckpoint({
			sessionId: "session-1",
			agent: "test-agent",
			message: "Test checkpoint",
			trigger: "manual",
			cwd: "/test/repo",
		});

		expect(cp.id).toHaveLength(12);
		expect(cp.session_id).toBe("session-1");
		expect(cp.agent).toBe("test-agent");
		expect(cp.message).toBe("Test checkpoint");
		expect(cp.trigger).toBe("manual");
		expect(cp.base_commit).toBe("abc123");
		expect(cp.files_changed).toEqual(["src/index.ts", "src/lib/config.ts"]);
		expect(cp.restorable).toBe(true);
		expect(mockWriteFileSync).toHaveBeenCalled();
	});

	it("throws when not in a git repo", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		mockExistsSync.mockReturnValue(false);

		expect(() =>
			createCheckpoint({
				sessionId: "s1",
				agent: "a1",
				message: "test",
				trigger: "manual",
				cwd: "/not/a/repo",
			}),
		).toThrow("Not a git repository");
	});
});

describe("listCheckpoints", () => {
	const sampleCheckpoints: Checkpoint[] = [
		{
			id: "aaa111",
			session_id: "s1",
			agent: "agent-1",
			message: "First",
			timestamp: "2025-01-01T00:00:00Z",
			base_commit: "abc",
			trigger: "manual",
			files_changed: ["a.ts"],
			restorable: true,
		},
		{
			id: "bbb222",
			session_id: "s2",
			agent: "agent-2",
			message: "Second",
			timestamp: "2025-01-02T00:00:00Z",
			base_commit: "def",
			trigger: "session_end",
			files_changed: ["b.ts"],
			restorable: true,
		},
		{
			id: "ccc333",
			session_id: "s1",
			agent: "agent-1",
			message: "Third",
			timestamp: "2025-01-03T00:00:00Z",
			base_commit: "ghi",
			trigger: "task_complete",
			files_changed: ["c.ts"],
			restorable: false,
		},
	];

	beforeEach(() => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			return String(path).includes("checkpoints.json");
		});
		mockReadFileSync.mockReturnValue(JSON.stringify(sampleCheckpoints));
	});

	it("returns all checkpoints sorted newest first", () => {
		const result = listCheckpoints({ cwd: "/test" });
		expect(result).toHaveLength(3);
		expect(result[0].id).toBe("ccc333");
		expect(result[2].id).toBe("aaa111");
	});

	it("filters by agent", () => {
		const result = listCheckpoints({ agent: "agent-1", cwd: "/test" });
		expect(result).toHaveLength(2);
		expect(result.every((c) => c.agent === "agent-1")).toBe(true);
	});

	it("filters by session", () => {
		const result = listCheckpoints({ session: "s1", cwd: "/test" });
		expect(result).toHaveLength(2);
	});

	it("applies limit", () => {
		const result = listCheckpoints({ limit: 1, cwd: "/test" });
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("ccc333"); // newest
	});
});

describe("getCheckpoint", () => {
	it("returns checkpoint by id", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify([
				{
					id: "abc123",
					message: "Found",
					session_id: "s1",
					agent: "a",
					timestamp: "",
					base_commit: "",
					trigger: "manual",
					files_changed: [],
					restorable: true,
				},
			]),
		);
		const cp = getCheckpoint("abc123", "/test");
		expect(cp?.message).toBe("Found");
	});

	it("returns null for unknown id", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify([]));
		expect(getCheckpoint("unknown", "/test")).toBeNull();
	});
});

describe("pruneCheckpoints", () => {
	it("prunes by keep_latest", () => {
		const three: Checkpoint[] = [
			{
				id: "a",
				session_id: "s",
				agent: "a",
				message: "1",
				timestamp: "2025-01-01T00:00:00Z",
				base_commit: "x",
				trigger: "manual",
				files_changed: [],
				restorable: true,
			},
			{
				id: "b",
				session_id: "s",
				agent: "a",
				message: "2",
				timestamp: "2025-01-02T00:00:00Z",
				base_commit: "x",
				trigger: "manual",
				files_changed: [],
				restorable: true,
			},
			{
				id: "c",
				session_id: "s",
				agent: "a",
				message: "3",
				timestamp: "2025-01-03T00:00:00Z",
				base_commit: "x",
				trigger: "manual",
				files_changed: [],
				restorable: true,
			},
		];

		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			return String(path).includes("checkpoints.json");
		});
		mockReadFileSync.mockReturnValue(JSON.stringify(three));

		const removed = pruneCheckpoints({ keep_latest: 2, cwd: "/test" });
		expect(removed).toBe(1);
	});
});

describe("archiveCheckpoints", () => {
	it("archives old restorable checkpoints", () => {
		// Pin "now" so the test is deterministic across clock changes.
		const fixedNow = new Date("2030-06-15T12:00:00Z");
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);

		try {
			const old: Checkpoint[] = [
				{
					id: "a",
					session_id: "s",
					agent: "a",
					message: "old",
					timestamp: "2020-01-01T00:00:00Z",
					base_commit: "x",
					trigger: "manual",
					files_changed: [],
					restorable: true,
					stash_ref: "abc",
				},
				{
					id: "b",
					session_id: "s",
					agent: "a",
					message: "new",
					timestamp: fixedNow.toISOString(),
					base_commit: "x",
					trigger: "manual",
					files_changed: [],
					restorable: true,
					stash_ref: "def",
				},
			];

			mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
				return String(path).includes("checkpoints.json");
			});
			mockReadFileSync.mockReturnValue(JSON.stringify(old));

			const result = archiveCheckpoints({ cwd: "/test" });
			expect(result.archived).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("shouldAutoCheckpoint", () => {
	it("returns true for session_end by default", () => {
		expect(shouldAutoCheckpoint("session_end")).toBe(true);
	});

	it("returns true for task_completed by default", () => {
		expect(shouldAutoCheckpoint("task_completed")).toBe(true);
	});

	it("returns false for tool_use", () => {
		expect(shouldAutoCheckpoint("tool_use")).toBe(false);
	});

	it("respects custom config", () => {
		expect(
			shouldAutoCheckpoint("session_start", { auto_checkpoint_on: ["session_start"] }),
		).toBe(true);
		expect(shouldAutoCheckpoint("session_end", { auto_checkpoint_on: ["session_start"] })).toBe(
			false,
		);
	});
});

describe("compareCheckpoints", () => {
	it("computes file diffs between two checkpoints", () => {
		const cps: Checkpoint[] = [
			{
				id: "from1",
				session_id: "s",
				agent: "a",
				message: "from",
				timestamp: "2025-01-01T00:00:00Z",
				base_commit: "aaa",
				trigger: "manual",
				files_changed: ["a.ts", "b.ts"],
				restorable: true,
			},
			{
				id: "to1",
				session_id: "s",
				agent: "a",
				message: "to",
				timestamp: "2025-01-02T00:00:00Z",
				base_commit: "bbb",
				trigger: "manual",
				files_changed: ["b.ts", "c.ts"],
				restorable: true,
			},
		];

		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify(cps));
		mockExecSync.mockReturnValue("2 files changed\n");

		const result = compareCheckpoints("from1", "to1", "/test");
		expect(result.files_added).toEqual(["c.ts"]);
		expect(result.files_deleted).toEqual(["a.ts"]);
		expect(result.files_modified).toEqual(["b.ts"]);
	});
});
