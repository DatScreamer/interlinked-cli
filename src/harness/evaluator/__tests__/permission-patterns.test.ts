import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addPermissionToSettings, extractPermissionPattern } from "../permission-patterns.js";

describe("extractPermissionPattern", () => {
	it("returns null for empty or missing commands", () => {
		expect(extractPermissionPattern("Bash", { command: "" })).toBeNull();
		expect(extractPermissionPattern("Bash", {})).toBeNull();
	});

	it("returns null for destructive commands", () => {
		expect(extractPermissionPattern("Bash", { command: "rm -rf /tmp/foo" })).toBeNull();
		expect(extractPermissionPattern("Bash", { command: "sudo reboot" })).toBeNull();
		expect(extractPermissionPattern("Bash", { command: "git push origin main" })).toBeNull();
	});

	it("includes subcommand for npm / yarn / pnpm", () => {
		expect(extractPermissionPattern("Bash", { command: "npm install" })).toBe(
			"Bash(npm install *)",
		);
		expect(extractPermissionPattern("Bash", { command: "yarn build" })).toBe(
			"Bash(yarn build *)",
		);
	});

	it("includes package for npx / bunx", () => {
		expect(extractPermissionPattern("Bash", { command: "npx vitest run" })).toBe(
			"Bash(npx vitest *)",
		);
	});

	it("extracts compound patterns from &&-chained commands", () => {
		expect(
			extractPermissionPattern("Bash", {
				command: "mkdir -p dist && cp -R src/* dist/ && git init && git commit -m x",
			}),
		).toBe("Bash(mkdir && cp && git init && git commit *)");
	});

	it("returns null if any compound segment is destructive", () => {
		expect(extractPermissionPattern("Bash", { command: "cp a b && rm -rf dist" })).toBeNull();
	});

	it("extracts domain-scoped pattern for WebFetch", () => {
		expect(extractPermissionPattern("WebFetch", { url: "https://example.com/foo" })).toBe(
			"WebFetch(domain:example.com)",
		);
		expect(extractPermissionPattern("WebFetch", { url: "not a url" })).toBeNull();
	});

	it("returns null for non-Bash, non-WebFetch tools", () => {
		expect(extractPermissionPattern("Read", { file_path: "/x" })).toBeNull();
	});
});

describe("addPermissionToSettings", () => {
	let tmpDir: string;
	const origCwd = process.cwd();

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "perm-"));
		process.chdir(tmpDir);
	});

	afterEach(() => {
		process.chdir(origCwd);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .claude/settings.json and persists a new pattern", () => {
		expect(addPermissionToSettings("Bash(ls *)")).toBe(true);
		const raw = readFileSync(join(tmpDir, ".claude", "settings.json"), "utf-8");
		const parsed = JSON.parse(raw) as { permissions: { allow: string[] } };
		expect(parsed.permissions.allow).toContain("Bash(ls *)");
	});

	it("returns false on duplicate and does not grow the allow list", () => {
		expect(addPermissionToSettings("Bash(ls *)")).toBe(true);
		expect(addPermissionToSettings("Bash(ls *)")).toBe(false);
		const raw = readFileSync(join(tmpDir, ".claude", "settings.json"), "utf-8");
		const parsed = JSON.parse(raw) as { permissions: { allow: string[] } };
		expect(parsed.permissions.allow.filter((p) => p === "Bash(ls *)")).toHaveLength(1);
	});
});
