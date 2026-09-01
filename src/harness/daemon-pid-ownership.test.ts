import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pidFileNames, removePidFileIfOwned } from "./daemon-pid-ownership.js";

describe("daemon pid-file ownership", () => {
	let dir: string;
	let pidPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-pid-owner-"));
		pidPath = join(dir, "daemon.pid");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("removes a pid file only while it still names the caller", () => {
		writeFileSync(pidPath, "42\n");
		expect(pidFileNames(pidPath, 42)).toBe(true);
		expect(removePidFileIfOwned(pidPath, 42)).toBe(true);
		expect(existsSync(pidPath)).toBe(false);
	});

	it("preserves a successor's pid file during predecessor cleanup", () => {
		writeFileSync(pidPath, "43");
		expect(removePidFileIfOwned(pidPath, 42)).toBe(false);
		expect(readFileSync(pidPath, "utf8")).toBe("43");
	});

	it("does not treat malformed or missing metadata as ownership", () => {
		writeFileSync(pidPath, "42garbage");
		expect(pidFileNames(pidPath, 42)).toBe(false);
		rmSync(pidPath);
		expect(removePidFileIfOwned(pidPath, 42)).toBe(false);
	});
});
