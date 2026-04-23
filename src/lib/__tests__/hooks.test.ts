import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deleteConfigDir,
	deleteHookScript,
	ensureGitignore,
	findProjectRoot,
	getHookScriptPath,
	HOOK_SCRIPT_VERSION,
	writeHookScript,
} from "../hooks.js";

describe("HOOK_SCRIPT_VERSION", () => {
	it("is a non-empty string", () => {
		expect(typeof HOOK_SCRIPT_VERSION).toBe("string");
		expect(HOOK_SCRIPT_VERSION.length).toBeGreaterThan(0);
	});
});

describe("findProjectRoot", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("walks up to find a `.git/` ancestor", () => {
		mkdirSync(join(tmp, ".git"), { recursive: true });
		mkdirSync(join(tmp, "a", "b"), { recursive: true });
		expect(findProjectRoot(join(tmp, "a", "b"))).toBe(tmp);
	});

	it("returns null (or an ancestor of tmp) when no .git/ is at tmp", () => {
		// On dev machines /Users/* is often inside a git repo — `findProjectRoot`
		// may walk up to that ancestor. We assert the behavior is a string or
		// null; if non-null, it is NOT tmp itself.
		const got = findProjectRoot(tmp);
		expect(got === null || (typeof got === "string" && got !== tmp)).toBe(true);
	});
});

describe("getHookScriptPath / writeHookScript / deleteHookScript", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("getHookScriptPath lives under .interlinked/hooks/", () => {
		const p = getHookScriptPath(tmp);
		expect(p.startsWith(join(tmp, ".interlinked", "hooks"))).toBe(true);
		expect(p.endsWith(".mjs")).toBe(true);
	});

	it("writeHookScript creates a .mjs file with the current version marker", () => {
		const p = writeHookScript(tmp);
		expect(existsSync(p)).toBe(true);
		const content = readFileSync(p, "utf-8");
		expect(content).toContain(HOOK_SCRIPT_VERSION);
	});

	it("deleteHookScript removes a previously-written script", () => {
		const p = writeHookScript(tmp);
		expect(existsSync(p)).toBe(true);
		expect(deleteHookScript(tmp)).toBe(true);
		expect(existsSync(p)).toBe(false);
	});

	it("deleteHookScript is a no-op when no script exists", () => {
		expect(deleteHookScript(tmp)).toBe(false);
	});
});

describe("deleteConfigDir", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("removes .interlinked/ when it exists", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		expect(deleteConfigDir(tmp)).toBe(true);
		expect(existsSync(join(tmp, ".interlinked"))).toBe(false);
	});

	it("returns false when .interlinked/ does not exist", () => {
		expect(deleteConfigDir(tmp)).toBe(false);
	});
});

describe("ensureGitignore", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes Interlinked entries to the project `.gitignore`", () => {
		const changed = ensureGitignore(tmp);
		expect(changed).toBe(true);
		const gi = readFileSync(join(tmp, ".gitignore"), "utf-8");
		expect(gi).toMatch(/config\.local\.json/);
	});

	it("is a no-op when the gitignore already matches", () => {
		ensureGitignore(tmp);
		expect(ensureGitignore(tmp)).toBe(false);
	});
});
