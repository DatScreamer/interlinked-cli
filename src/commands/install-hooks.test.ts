import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHooksCommand, parseModeChoice } from "./install-hooks.js";

let tmp = "";
let originalCwd = "";

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-ih-"));
	originalCwd = process.cwd();
	process.chdir(tmp);
});
afterEach(() => {
	process.chdir(originalCwd);
	rmSync(tmp, { recursive: true, force: true });
});

describe("install-hooks command", () => {
	it("installs for the claude-code runner and writes the settings file", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({ runner: "claude-code", binary: "/usr/bin/ih-binary" });
		spy.mockRestore();
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(true);
		expect(existsSync(join(tmp, ".interlinked", "installer-manifest.json"))).toBe(true);
	});

	it("installs all runners when runner='all'", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({ runner: "all", binary: "/usr/bin/ih-binary" });
		spy.mockRestore();
		const manifest = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "installer-manifest.json"), "utf-8"),
		) as { entries: Array<{ runner: string }> };
		expect(manifest.entries.length).toBe(5);
	});

	it("respects --dry-run", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-binary",
			dryRun: true,
		});
		spy.mockRestore();
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
	});

	it("writes cloud.json when --cloud is provided", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-binary",
			cloud: "guardrails",
			tokenEnv: "MY_TOKEN",
		});
		spy.mockRestore();
		const cloud = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "cloud.json"), "utf-8"),
		) as {
			enabled: boolean;
			product: string;
			token_source: { env: string };
		};
		expect(cloud.enabled).toBe(true);
		expect(cloud.product).toBe("guardrails");
		expect(cloud.token_source.env).toBe("MY_TOKEN");
	});

	it("warns and skips unknown runners", async () => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "not-a-runner,claude-code",
			binary: "/usr/bin/ih-binary",
		});
		expect(stderrSpy).toHaveBeenCalled();
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(true);
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("accepts --mode strict and records it in check-policy.json", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-mode",
			mode: "strict",
		});
		spy.mockRestore();
		const path = join(tmp, ".interlinked", "check-policy.json");
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mode: string };
		expect(parsed.mode).toBe("strict");
	});

	it("warns on unknown --mode and defaults to balanced", async () => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-mode-bad",
			mode: "super-strict",
		});
		expect(stderrSpy).toHaveBeenCalled();
		const parsed = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		) as { mode: string };
		expect(parsed.mode).toBe("balanced");
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("produces JSON output when --json set", async () => {
		let captured = "";
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
			buf: string | Uint8Array,
		) => {
			captured += typeof buf === "string" ? buf : Buffer.from(buf).toString("utf-8");
			return true;
		}) as unknown as typeof process.stdout.write);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-binary",
			json: true,
		});
		spy.mockRestore();
		const payload = JSON.parse(captured) as { ok: boolean; entries: unknown[] };
		expect(payload.ok).toBe(true);
		expect(payload.entries.length).toBe(1);
	});
});

describe("parseModeChoice", () => {
	it("returns balanced for empty input", () => {
		expect(parseModeChoice("")).toBe("balanced");
		expect(parseModeChoice("  ")).toBe("balanced");
	});
	it("accepts numeric index (1-based)", () => {
		expect(parseModeChoice("1")).toBe("balanced");
		expect(parseModeChoice("2")).toBe("strict");
		expect(parseModeChoice("3")).toBe("lenient");
	});
	it("accepts the mode name directly", () => {
		expect(parseModeChoice("strict")).toBe("strict");
		expect(parseModeChoice("LENIENT")).toBe("lenient");
	});
	it("falls back to balanced on unknown input", () => {
		expect(parseModeChoice("bogus")).toBe("balanced");
		expect(parseModeChoice("99")).toBe("balanced");
	});
});
