import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs before importing
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		mkdirSync: vi.fn(),
	};
});

// Mock config
vi.mock("../../lib/config.js", () => ({
	readLocalConfig: vi.fn(() => ({ agent_name: "test-agent" })),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { reminderAddCommand, reminderListCommand, reminderRemoveCommand } from "../reminder.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

function mockGuardRulesFile(local: boolean, content: Record<string, unknown> | null) {
	mockExistsSync.mockImplementation((p) => {
		const path = String(p);
		if (local && path.includes("guard-rules.local.json")) return content !== null;
		if (!local && path.includes("guard-rules.json") && !path.includes("local"))
			return content !== null;
		// .interlinked dir exists
		if (path.endsWith(".interlinked")) return true;
		return false;
	});
	mockReadFileSync.mockImplementation((p) => {
		const path = String(p);
		if (content && local && path.includes("guard-rules.local.json"))
			return JSON.stringify(content);
		if (content && !local && path.includes("guard-rules.json") && !path.includes("local"))
			return JSON.stringify(content);
		throw new Error("ENOENT");
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("reminder add", () => {
	it("writes reminder to local guard rules", () => {
		mockGuardRulesFile(true, null);
		reminderAddCommand({ glob: "src/auth/**", message: "Run auth tests" });

		expect(mockWriteFileSync).toHaveBeenCalledOnce();
		const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
		expect(written.file_reminders).toHaveLength(1);
		expect(written.file_reminders[0].glob).toBe("src/auth/**");
		expect(written.file_reminders[0].message).toBe("Run auth tests");
		expect(written.file_reminders[0].id).toMatch(/^reminder-/);
		expect(written.file_reminders[0].created_at).toBeTruthy();
		expect(written.file_reminders[0].created_by).toBe("test-agent");
	});

	it("appends to existing reminders", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "old/**", message: "old", id: "old-id" }],
		});
		reminderAddCommand({ glob: "new/**", message: "new" });

		const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
		expect(written.file_reminders).toHaveLength(2);
		expect(written.file_reminders[1].glob).toBe("new/**");
	});

	it("rejects duplicate id", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "src/auth/**", message: "exists", id: "reminder-309fbaef" }],
		});
		reminderAddCommand({ glob: "src/auth/**", message: "duplicate" });

		expect(mockWriteFileSync).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalled();
	});

	it("parses --ops into operations array", () => {
		mockGuardRulesFile(true, null);
		reminderAddCommand({ glob: "*.ts", message: "test", ops: "Edit,Write" });

		const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
		expect(written.file_reminders[0].operations).toEqual(["Edit", "Write"]);
	});

	it("writes to team file with --team", () => {
		mockGuardRulesFile(false, null);
		reminderAddCommand({ glob: "*.ts", message: "team reminder", team: true });

		expect(mockWriteFileSync).toHaveBeenCalledOnce();
		const path = mockWriteFileSync.mock.calls[0][0] as string;
		expect(path).toContain("guard-rules.json");
		expect(path).not.toContain("local");
	});

	it("errors when --glob or --message missing", () => {
		reminderAddCommand({ glob: "*.ts" });
		expect(console.error).toHaveBeenCalled();
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});
});

describe("reminder list", () => {
	it("shows empty state", () => {
		mockGuardRulesFile(true, null);
		mockGuardRulesFile(false, null);
		reminderListCommand({});
		expect(console.log).toHaveBeenCalled();
	});

	it("annotates team and local sources in JSON", () => {
		// Mock both files existing
		mockExistsSync.mockImplementation((p) => {
			const path = String(p);
			if (path.includes("guard-rules.local.json")) return true;
			if (path.includes("guard-rules.json") && !path.includes("local")) return true;
			if (path.endsWith(".interlinked")) return true;
			return false;
		});
		mockReadFileSync.mockImplementation((p) => {
			const path = String(p);
			if (path.includes("guard-rules.local.json"))
				return JSON.stringify({
					file_reminders: [{ glob: "local/**", message: "local one" }],
				});
			if (path.includes("guard-rules.json") && !path.includes("local"))
				return JSON.stringify({
					file_reminders: [{ glob: "team/**", message: "team one" }],
				});
			throw new Error("ENOENT");
		});

		reminderListCommand({ json: true });
		const output = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		expect(output).toHaveLength(2);
		expect(output[0].source).toBe("team");
		expect(output[1].source).toBe("local");
	});
});

describe("reminder remove", () => {
	it("removes by id", () => {
		mockGuardRulesFile(true, {
			file_reminders: [
				{ glob: "a/**", message: "a", id: "rem-a" },
				{ glob: "b/**", message: "b", id: "rem-b" },
			],
		});
		reminderRemoveCommand("rem-a", {});

		const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
		expect(written.file_reminders).toHaveLength(1);
		expect(written.file_reminders[0].id).toBe("rem-b");
	});

	it("removes by glob", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "src/auth/**", message: "auth", id: "rem-auth" }],
		});
		reminderRemoveCommand("src/auth/**", {});

		const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
		expect(written.file_reminders).toHaveLength(0);
	});

	it("removes all with --all", () => {
		mockGuardRulesFile(true, {
			file_reminders: [
				{ glob: "a/**", message: "a", id: "rem-a" },
				{ glob: "b/**", message: "b", id: "rem-b" },
			],
		});
		reminderRemoveCommand(undefined, { all: true });

		const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
		expect(written.file_reminders).toHaveLength(0);
	});

	it("errors when no match found", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "a/**", message: "a", id: "rem-a" }],
		});
		reminderRemoveCommand("nonexistent", {});

		expect(console.error).toHaveBeenCalled();
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it("errors when no arg and no --all", () => {
		reminderRemoveCommand(undefined, {});
		expect(console.error).toHaveBeenCalled();
	});
});
