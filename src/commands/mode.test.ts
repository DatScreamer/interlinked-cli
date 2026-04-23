import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modeCommand, writeMode } from "./mode.js";

let tmp = "";
let originalCwd = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-mode-"));
	originalCwd = process.cwd();
	process.chdir(tmp);
	mkdirSync(join(tmp, ".interlinked"));
	process.exitCode = 0;
});
afterEach(() => {
	process.chdir(originalCwd);
	process.exitCode = 0;
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
	return { text: () => captured, restore: () => spy.mockRestore() };
}

describe("writeMode", () => {
	it("creates the shared config when absent", () => {
		writeMode(tmp, "strict", false);
		const path = join(tmp, ".interlinked", "check-policy.json");
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.mode).toBe("strict");
		expect(parsed.version).toBe(1);
	});

	it("preserves existing fields when updating mode", () => {
		const path = join(tmp, ".interlinked", "check-policy.json");
		writeFileSync(
			path,
			JSON.stringify({ version: 1, checks: { focused_tests: { action: "block_preview" } } }),
		);
		writeMode(tmp, "strict", false);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.mode).toBe("strict");
		expect(parsed.checks.focused_tests.action).toBe("block_preview");
	});

	it("writes to the local file when local=true", () => {
		writeMode(tmp, "lenient", true);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.local.json"))).toBe(true);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});
});

describe("modeCommand — show current", () => {
	it("reports built-in default when no config exists", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("Current: balanced");
		expect(cap.text()).toContain("built-in default");
	});

	it("reports mode from a written shared config", async () => {
		writeMode(tmp, "strict", false);
		const cap = captureStdout();
		await modeCommand(undefined, {});
		cap.restore();
		expect(cap.text()).toContain("Current: strict");
	});

	it("JSON output enumerates available modes", async () => {
		const cap = captureStdout();
		await modeCommand(undefined, { json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as {
			mode: string;
			available_modes: Array<{ name: string }>;
		};
		expect(payload.mode).toBe("balanced");
		expect(payload.available_modes.length).toBe(3);
	});
});

describe("modeCommand — diff preview", () => {
	it("prints changes that strict would introduce", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { diff: true });
		cap.restore();
		expect(cap.text()).toContain("Switching to strict would change");
		expect(cap.text()).toContain("focused_tests");
	});

	it("reports no changes when switching balanced → balanced", async () => {
		const cap = captureStdout();
		await modeCommand("balanced", { diff: true });
		cap.restore();
		expect(cap.text()).toContain("would not change");
	});

	it("JSON diff output is a structured list", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { diff: true, json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as { mode: string; changes: unknown[] };
		expect(payload.mode).toBe("strict");
		expect(payload.changes.length).toBeGreaterThan(0);
	});
});

describe("modeCommand — apply with --force", () => {
	it("writes the shared file and reports success", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true });
		cap.restore();
		expect(cap.text()).toContain("Mode set to strict");
		const parsed = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		);
		expect(parsed.mode).toBe("strict");
	});

	it("writes the local override with --local", async () => {
		const cap = captureStdout();
		await modeCommand("lenient", { force: true, local: true });
		cap.restore();
		expect(existsSync(join(tmp, ".interlinked", "check-policy.local.json"))).toBe(true);
	});

	it("JSON output reports the written path", async () => {
		const cap = captureStdout();
		await modeCommand("strict", { force: true, json: true });
		cap.restore();
		const payload = JSON.parse(cap.text()) as { ok: boolean; path: string };
		expect(payload.ok).toBe(true);
		expect(payload.path.endsWith("check-policy.json")).toBe(true);
	});
});

describe("modeCommand — error paths", () => {
	it("rejects unknown mode names", async () => {
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await modeCommand("super-strict", { force: true });
		expect(process.exitCode).toBe(1);
		spy.mockRestore();
	});
});
