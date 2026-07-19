// Phase 1 Channel 5 — rollback-feasibility tests.
// Pin the safety contract: argv-shape, `--` option-parser termination,
// porcelain -z parsing, provenance gate, and adversarial-filename behavior
// (filenames like `--all`, paths with whitespace, paths with shell
// metacharacters). Without these, a regression here could open a
// shell-injection surface.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	assessRollbackFeasibility,
	formatRollbackLine,
} from "../rollback-feasibility.js";

let cwd: string;

function init(): void {
	cwd = mkdtempSync(join(tmpdir(), "rollback-test-"));
	execSync("git init -q", { cwd });
	execSync("git config user.email test@example.com", { cwd });
	execSync("git config user.name test", { cwd });
	execSync("git config commit.gpgsign false", { cwd });
}

function cleanup(): void {
	if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
}

beforeEach(init);
afterEach(cleanup);

const allowAll = (): boolean => true;
const denyAll = (): boolean => false;

describe("assessRollbackFeasibility — clean tree", () => {
	it("returns safe:false when nothing changed", () => {
		const r = assessRollbackFeasibility("README.md", cwd, allowAll);
		expect(r.safe).toBe(false);
		expect(r.reason).toMatch(/no working-tree change/i);
	});
});

describe("assessRollbackFeasibility — untracked file", () => {
	it("returns rm command for untracked file with provenance", () => {
		writeFileSync(join(cwd, "new.txt"), "hi");
		const r = assessRollbackFeasibility("new.txt", cwd, allowAll);
		expect(r.safe).toBe(true);
		expect(r.command).toEqual(["rm", "--", "new.txt"]);
		expect(r.caused_by_us).toBe(true);
	});
	it("refuses untracked file without provenance", () => {
		writeFileSync(join(cwd, "new.txt"), "hi");
		const r = assessRollbackFeasibility("new.txt", cwd, denyAll);
		expect(r.safe).toBe(false);
		expect(r.caused_by_us).toBe(false);
		expect(r.reason).toMatch(/no provenance evidence/i);
	});
});

describe("assessRollbackFeasibility — tracked, modified working tree", () => {
	it("returns git checkout for unstaged modification with provenance", () => {
		writeFileSync(join(cwd, "tracked.txt"), "v1");
		execSync("git add tracked.txt && git commit -q -m v1", { cwd });
		writeFileSync(join(cwd, "tracked.txt"), "v2");
		const r = assessRollbackFeasibility("tracked.txt", cwd, allowAll);
		expect(r.safe).toBe(true);
		expect(r.command).toEqual(["git", "checkout", "--", "tracked.txt"]);
	});
	it("refuses staged + unstaged combo", () => {
		writeFileSync(join(cwd, "tracked.txt"), "v1");
		execSync("git add tracked.txt && git commit -q -m v1", { cwd });
		writeFileSync(join(cwd, "tracked.txt"), "v2");
		execSync("git add tracked.txt", { cwd });
		writeFileSync(join(cwd, "tracked.txt"), "v3");
		const r = assessRollbackFeasibility("tracked.txt", cwd, allowAll);
		expect(r.safe).toBe(false);
		expect(r.reason).toMatch(/complex git state/i);
	});
});

describe("assessRollbackFeasibility — argv shape (shell-injection safety)", () => {
	it("returns argv (not a shell string) for a path with spaces", () => {
		mkdirSync(join(cwd, "with space"), { recursive: true });
		writeFileSync(join(cwd, "with space/file.txt"), "x");
		const r = assessRollbackFeasibility("with space/file.txt", cwd, allowAll);
		expect(r.safe).toBe(true);
		expect(r.command).toEqual(["rm", "--", "with space/file.txt"]);
	});
	it("returns argv for a filename starting with '--' (parser-confusing)", () => {
		writeFileSync(join(cwd, "--all"), "x");
		const r = assessRollbackFeasibility("--all", cwd, allowAll);
		// `--` in argv terminates option parsing — git/rm treat the next
		// element as a literal pathname, so even '--all' is safe.
		expect(r.safe).toBe(true);
		expect(r.command).toEqual(["rm", "--", "--all"]);
	});
	it("returns argv for a filename with shell metacharacters", () => {
		writeFileSync(join(cwd, "name;with`metas$.txt"), "x");
		const r = assessRollbackFeasibility("name;with`metas$.txt", cwd, allowAll);
		expect(r.safe).toBe(true);
		expect(r.command).toEqual(["rm", "--", "name;with`metas$.txt"]);
	});
	it("returns argv for a filename with newline", () => {
		writeFileSync(join(cwd, "line\nbreak"), "x");
		const r = assessRollbackFeasibility("line\nbreak", cwd, allowAll);
		// Even with a newline in the name, the argv shape preserves it
		// exactly — porcelain -z's null delimiter is what makes this parseable.
		expect(r.safe).toBe(true);
		expect(r.command).toEqual(["rm", "--", "line\nbreak"]);
	});
});

describe("assessRollbackFeasibility — non-git directory", () => {
	it("returns safe:false outside a git repo", () => {
		const tmp = mkdtempSync(join(tmpdir(), "rollback-no-git-"));
		try {
			const r = assessRollbackFeasibility("anything.txt", tmp, allowAll);
			expect(r.safe).toBe(false);
			expect(r.reason).toMatch(/git status failed/i);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("formatRollbackLine — display safety", () => {
	it("returns null for unsafe assessments", () => {
		expect(formatRollbackLine({ safe: false, reason: "no", caused_by_us: false })).toBeNull();
	});
	it("quotes paths with whitespace in display", () => {
		const line = formatRollbackLine({
			safe: true,
			caused_by_us: true,
			reason: "ok",
			command: ["rm", "--", "with space.txt"],
		});
		expect(line).not.toBeNull();
		// Path with whitespace must be quoted so a copy-paste into a shell
		// parses it as one argument.
		expect(line).toContain("'with space.txt'");
	});
	it("escapes embedded single quotes", () => {
		const line = formatRollbackLine({
			safe: true,
			caused_by_us: true,
			reason: "ok",
			command: ["rm", "--", "it's-mine.txt"],
		});
		expect(line).toContain("'it'\\''s-mine.txt'");
	});
	it("leaves plain paths unquoted", () => {
		const line = formatRollbackLine({
			safe: true,
			caused_by_us: true,
			reason: "ok",
			command: ["git", "checkout", "--", "src/foo.ts"],
		});
		expect(line).toContain("git checkout -- src/foo.ts");
	});
});
