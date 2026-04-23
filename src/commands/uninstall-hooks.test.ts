import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHooksCommand } from "./install-hooks.js";
import { uninstallHooksCommand } from "./uninstall-hooks.js";

let tmp = "";
let originalCwd = "";

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-uh-"));
	originalCwd = process.cwd();
	process.chdir(tmp);
});
afterEach(() => {
	process.chdir(originalCwd);
	rmSync(tmp, { recursive: true, force: true });
});

describe("uninstall-hooks — round trip with install-hooks", () => {
	it("removes claude-code hooks leaving copilot intact", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "claude-code,copilot-cli",
			binary: "/usr/bin/ih-binary-uh",
		});
		const before = readFileSync(join(tmp, ".claude", "settings.json"), "utf-8");
		expect(before).toContain("ih-binary-uh");

		await uninstallHooksCommand({ runner: "claude-code" });
		spy.mockRestore();
		const after = readFileSync(join(tmp, ".claude", "settings.json"), "utf-8");
		expect(after).not.toContain("ih-binary-uh");
		expect(existsSync(join(tmp, ".github", "hooks", "hooks.json"))).toBe(true);
	});

	it("removes everything when no runner filter is given", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "claude-code,copilot-cli",
			binary: "/usr/bin/ih-all",
		});
		await uninstallHooksCommand({});
		spy.mockRestore();
		const claude = readFileSync(join(tmp, ".claude", "settings.json"), "utf-8");
		expect(claude).not.toContain("ih-all");
	});

	it("supports dry-run (no file changes)", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({ runner: "claude-code", binary: "/usr/bin/ih-dry" });
		const before = readFileSync(join(tmp, ".claude", "settings.json"), "utf-8");
		await uninstallHooksCommand({ runner: "claude-code", dryRun: true });
		const after = readFileSync(join(tmp, ".claude", "settings.json"), "utf-8");
		spy.mockRestore();
		expect(after).toBe(before);
	});

	it("JSON output reports removal counts", async () => {
		let captured = "";
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
			buf: string | Uint8Array,
		) => {
			captured += typeof buf === "string" ? buf : Buffer.from(buf).toString("utf-8");
			return true;
		}) as unknown as typeof process.stdout.write);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-json",
			json: true,
		});
		captured = "";
		await uninstallHooksCommand({ json: true });
		spy.mockRestore();
		const payload = JSON.parse(captured) as { removed: unknown[] };
		expect(payload.removed.length).toBe(1);
	});
});
