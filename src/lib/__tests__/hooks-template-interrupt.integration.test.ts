import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHookScript } from "../hooks-template.js";
import { isJsonObject, type JsonObject } from "../json-types.js";

function parseActivityRecord(line: string): JsonObject {
	const parsed: unknown = JSON.parse(line);
	if (!isJsonObject(parsed)) throw new Error("activity row must be a JSON object");
	return parsed;
}

describe("generated Codex Interrupt hook", () => {
	it("records the strict payload locally while emitting zero output", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-interrupt-"));
		const interlinkedDir = join(tempDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({ sync_mode: "local", agent_name: "interrupt-observer" }),
		);
		writeFileSync(join(interlinkedDir, "harness.pid"), String(process.pid));
		writeFileSync(join(interlinkedDir, "harness.sock"), "");
		const transcriptPath = join(tempDir, "transcript.jsonl");
		writeFileSync(transcriptPath, "");
		const scriptPath = join(tempDir, "hook.mjs");
		writeFileSync(scriptPath, buildHookScript("interrupt-test"));

		const result = spawnSync(process.execPath, [scriptPath], {
			input: JSON.stringify({
				cwd: tempDir,
				hook_event_name: "Interrupt",
				model: "test-model",
				permission_mode: "default",
				session_id: "interrupt-session",
				transcript_path: transcriptPath,
				turn_id: "interrupt-turn",
			}),
			encoding: "utf-8",
			cwd: tempDir,
			env: {
				...process.env,
				INTERLINKED_HOME: interlinkedDir,
				INTERLINKED_DATA_DIR: interlinkedDir,
				INTERLINKED_CLIENT: "codex",
			},
			timeout: 20_000,
		});

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const activityPath = join(interlinkedDir, "activity.jsonl");
		expect(existsSync(activityPath)).toBe(true);
		const records = readFileSync(activityPath, "utf-8")
			.trim()
			.split("\n")
			.map(parseActivityRecord);
		expect(records).toContainEqual(
			expect.objectContaining({
				type: "interrupt",
				hook: "Interrupt",
				session: "interrupt-session",
				model: "test-model",
				permission_mode: "default",
				transcript_path: transcriptPath,
				turn_id: "interrupt-turn",
			}),
		);
	});
});
