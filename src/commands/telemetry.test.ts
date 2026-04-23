import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryShowCommand } from "./telemetry.js";

let tmp = "";
let originalCwd = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-tel-"));
	originalCwd = process.cwd();
	process.chdir(tmp);
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
});
afterEach(() => {
	process.chdir(originalCwd);
	rmSync(tmp, { recursive: true, force: true });
});

function captureStdout(): { text: () => string; restore: () => void } {
	let captured = "";
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
		buf: string | Uint8Array,
	) => {
		captured += typeof buf === "string" ? buf : Buffer.from(buf).toString("utf-8");
		return true;
	}) as unknown as typeof process.stdout.write);
	return {
		text: () => captured,
		restore: () => spy.mockRestore(),
	};
}

describe("telemetry show", () => {
	it("reports no spool when file is missing", async () => {
		const cap = captureStdout();
		await telemetryShowCommand({});
		cap.restore();
		expect(cap.text()).toContain("no spool");
	});

	it("prints events from an existing spool", async () => {
		writeFileSync(
			join(tmp, ".interlinked", "offline-spool.jsonl"),
			'{"schema":"v1","kind":"hook_decision","ts":"2026-04-23T00:00:00.000Z","session_id":"s1","decision":"allow"}\n' +
				'{"schema":"v1","kind":"session_lifecycle","ts":"2026-04-23T00:00:01.000Z","session_id":"s1"}\n',
		);
		const cap = captureStdout();
		await telemetryShowCommand({});
		cap.restore();
		const text = cap.text();
		expect(text).toContain("hook_decision");
		expect(text).toContain("session_lifecycle");
	});

	it("JSON output emits the events array", async () => {
		writeFileSync(
			join(tmp, ".interlinked", "offline-spool.jsonl"),
			'{"schema":"v1","kind":"check_finding","ts":"2026-04-23T00:00:00.000Z","session_id":"s2"}\n',
		);
		const cap = captureStdout();
		await telemetryShowCommand({ json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as { events: Array<{ kind: string }> };
		expect(payload.events.length).toBe(1);
		expect(payload.events[0].kind).toBe("check_finding");
	});

	it("--limit slices from the end", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 10; i++) {
			lines.push(
				`{"schema":"v1","kind":"hook_decision","ts":"2026-04-23T00:00:${String(i).padStart(
					2,
					"0",
				)}.000Z","session_id":"s-${i}"}`,
			);
		}
		writeFileSync(join(tmp, ".interlinked", "offline-spool.jsonl"), `${lines.join("\n")}\n`);
		const cap = captureStdout();
		await telemetryShowCommand({ limit: "3", json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as { events: Array<{ session_id: string }> };
		expect(payload.events.length).toBe(3);
		expect(payload.events[2].session_id).toBe("s-9");
	});
});
