// `interlinked experience` actions — export/analyze/list over session logs.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	experienceAnalyzeAction,
	experienceExportAction,
	experienceListAction,
} from "./experience.js";

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

function writeTimeline(): void {
	const rows = [
		{
			schema: "timeline.v1",
			ts: "2026-07-27T10:00:00.000Z",
			session: "sess-a",
			uuid: "u1",
			seq: 0,
			provider: "claude-code",
			category: "user_prompt",
			role: "user",
			text: "Do the thing.",
		},
		{
			schema: "timeline.v1",
			ts: "2026-07-27T10:00:01.000Z",
			session: "sess-a",
			uuid: "u2",
			seq: 0,
			provider: "claude-code",
			category: "agent_message",
			role: "assistant",
			text: "Done.",
		},
		{
			schema: "timeline.v1",
			ts: "2026-07-27T11:00:00.000Z",
			session: "sess-b",
			uuid: "u3",
			seq: 0,
			provider: "codex",
			category: "agent_message",
			role: "assistant",
			text: "Other session.",
		},
	];
	writeFileSync(
		join(dir, ".interlinked", "timeline.jsonl"),
		`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "experience-cmd-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeTimeline();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
	logSpy.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

function loggedText(): string {
	return logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

describe("experienceExportAction", () => {
	it("writes an ix trajectory file under .interlinked/trajectories/", () => {
		const code = experienceExportAction({ session: "sess-a", cwd: dir, json: true });
		expect(code).toBe(0);
		const outPath = join(dir, ".interlinked", "trajectories", "sess-a.ix.jsonl");
		expect(existsSync(outPath)).toBe(true);
		const lines = readFileSync(outPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(3);
		// SAFETY: first exported line is the meta record by construction.
		const meta = JSON.parse(lines[0] as string) as { role: string; schema?: string };
		expect(meta.role).toBe("meta");
		expect(meta.schema).toBe("trajectory-ix.v1");
	});

	it("exports the letta interop format without ix annotations", () => {
		const code = experienceExportAction({
			session: "sess-a",
			cwd: dir,
			format: "letta",
			json: true,
		});
		expect(code).toBe(0);
		const outPath = join(dir, ".interlinked", "trajectories", "sess-a.letta.jsonl");
		const lines = readFileSync(outPath, "utf-8").trim().split("\n");
		// SAFETY: first exported line is the meta record by construction.
		const meta = JSON.parse(lines[0] as string) as Record<string, unknown>;
		expect(meta.schema).toBeUndefined();
		expect(meta.role).toBe("meta");
	});

	it("fails with exit 1 for a session with no records", () => {
		const code = experienceExportAction({ session: "sess-none", cwd: dir, json: true });
		expect(code).toBe(1);
	});

	it("rejects a non-numeric --truncate instead of exporting uncapped", () => {
		const code = experienceExportAction({
			session: "sess-a",
			cwd: dir,
			truncate: "banana",
			json: true,
		});
		expect(code).toBe(1);
	});
});

describe("experienceAnalyzeAction", () => {
	it("prints deterministic metrics for the session", () => {
		const code = experienceAnalyzeAction({ session: "sess-a", cwd: dir, json: true });
		expect(code).toBe(0);
		// SAFETY: --json mode prints exactly one JSON document.
		const parsed = JSON.parse(loggedText()) as { records: number; by_role: Record<string, number> };
		expect(parsed.records).toBe(2);
		expect(parsed.by_role).toEqual({ user: 1, assistant: 1 });
	});
});

describe("experienceListAction", () => {
	it("lists sessions newest-last-activity first with record counts", () => {
		const code = experienceListAction({ cwd: dir, json: true });
		expect(code).toBe(0);
		// SAFETY: --json mode prints exactly one JSON document.
		const parsed = JSON.parse(loggedText()) as {
			sessions: { session: string; records: number; provider: string | null }[];
		};
		expect(parsed.sessions.map((s) => s.session)).toEqual(["sess-b", "sess-a"]);
		expect(parsed.sessions[1]).toMatchObject({ session: "sess-a", records: 2 });
	});
});
