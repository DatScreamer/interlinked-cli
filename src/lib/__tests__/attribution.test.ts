import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import {
	calculateAttribution,
	type PreRunSnapshot,
	readAttributionTrailer,
	snapshotPreRun,
} from "../attribution.js";

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
	vi.restoreAllMocks();
	// Re-mock after restore
	mockExecSync.mockImplementation(() => "");
});

function setupGitMock(responses: string[]) {
	let callIndex = 0;
	mockExecSync.mockImplementation(() => {
		const response = responses[callIndex] || "";
		callIndex++;
		return response;
	});
}

describe("snapshotPreRun", () => {
	it("captures files with changes", () => {
		setupGitMock([
			"10\t5\tsrc/index.ts\n3\t1\tsrc/lib/config.ts", // diff --numstat
			"", // ls-files --others
		]);

		const snap = snapshotPreRun("/test/cwd");
		expect(snap.files["src/index.ts"]).toBe(15);
		expect(snap.files["src/lib/config.ts"]).toBe(4);
		expect(snap.timestamp).toBeDefined();
	});

	it("handles no changes gracefully", () => {
		setupGitMock(["", ""]);

		const snap = snapshotPreRun("/test/cwd");
		expect(Object.keys(snap.files)).toHaveLength(0);
	});

	it("handles git errors gracefully", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("not a git repo");
		});

		const snap = snapshotPreRun("/test/cwd");
		expect(Object.keys(snap.files)).toHaveLength(0);
	});
});

describe("calculateAttribution", () => {
	it("attributes new lines to agent", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: { "src/index.ts": 5 },
		};

		setupGitMock([
			"15\t0\tsrc/index.ts", // diff --numstat
			"", // ls-files --others
		]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.agent_lines).toBe(10);
		expect(result.human_lines).toBe(5);
		expect(result.total_lines).toBe(15);
		expect(result.agent_percentage).toBe(67);
	});

	it("attributes all lines to agent for new files", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: {},
		};

		setupGitMock([
			"20\t0\tnew-file.ts", // diff --numstat
			"", // ls-files --others
		]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.agent_lines).toBe(20);
		expect(result.human_lines).toBe(0);
		expect(result.agent_percentage).toBe(100);
	});

	it("handles no changes", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: {},
		};

		setupGitMock(["", ""]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.agent_lines).toBe(0);
		expect(result.human_lines).toBe(0);
		expect(result.agent_percentage).toBe(0);
	});

	it("handles all human (pre-existing) lines", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: { "src/index.ts": 10 },
		};

		setupGitMock([
			"10\t0\tsrc/index.ts", // diff --numstat
			"", // ls-files --others
		]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.agent_lines).toBe(0);
		expect(result.human_lines).toBe(10);
		expect(result.agent_percentage).toBe(0);
	});

	it("per_file attribution", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: { "a.ts": 5, "b.ts": 3 },
		};

		setupGitMock([
			"10\t0\ta.ts\n3\t0\tb.ts\n8\t0\tc.ts", // diff --numstat
			"", // ls-files --others
		]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.per_file["a.ts"]).toEqual({ agent: 5, human: 5 });
		expect(result.per_file["b.ts"]).toEqual({ agent: 0, human: 3 });
		expect(result.per_file["c.ts"]).toEqual({ agent: 8, human: 0 });
	});
});

describe("readAttributionTrailer", () => {
	it("parses attribution trailer from commit message", () => {
		setupGitMock([
			"Fix bug in login flow\n\nInterlinked-Attribution: 73% agent (146/200 lines)",
		]);

		const result = readAttributionTrailer("HEAD", "/test/cwd");
		expect(result).not.toBeNull();
		expect(result!.agent_percentage).toBe(73);
		expect(result!.agent_lines).toBe(146);
		expect(result!.total_lines).toBe(200);
		expect(result!.human_lines).toBe(54);
	});

	it("returns null when no trailer", () => {
		setupGitMock(["Fix bug in login flow"]);

		const result = readAttributionTrailer("HEAD", "/test/cwd");
		expect(result).toBeNull();
	});

	it("returns null on git error", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("bad ref");
		});

		const result = readAttributionTrailer("badref", "/test/cwd");
		expect(result).toBeNull();
	});
});
