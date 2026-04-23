import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonsCommand } from "./daemons.js";

let tmp = "";
let originalCwd = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-dm-"));
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

describe("daemons command", () => {
	it("reports no daemons when .interlinked is empty", async () => {
		const cap = captureStdout();
		await daemonsCommand({});
		cap.restore();
		expect(cap.text()).toContain("no daemons found");
	});

	it("lists a discovered daemon (dead process)", async () => {
		writeFileSync(join(tmp, ".interlinked", "harness-deadsess.pid"), "999999999");
		const cap = captureStdout();
		await daemonsCommand({});
		cap.restore();
		const out = cap.text();
		expect(out).toContain("deadsess");
		expect(out).toContain("dead");
	});

	it("JSON output enumerates daemons", async () => {
		writeFileSync(join(tmp, ".interlinked", "harness-json1.pid"), "999999999");
		const cap = captureStdout();
		await daemonsCommand({ json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as {
			ok: boolean;
			daemons: Array<{ session_id: string }>;
		};
		expect(payload.ok).toBe(true);
		expect(payload.daemons.length).toBe(1);
		expect(payload.daemons[0].session_id).toBe("json1");
	});

	it("cleanup removes orphan PID files", async () => {
		const pidPath = join(tmp, ".interlinked", "harness-orphan.pid");
		writeFileSync(pidPath, "999999999");
		const cap = captureStdout();
		await daemonsCommand({ cleanup: true });
		cap.restore();
		expect(cap.text()).toContain("orphan");
		const { existsSync } = await import("node:fs");
		expect(existsSync(pidPath)).toBe(false);
	});
});
