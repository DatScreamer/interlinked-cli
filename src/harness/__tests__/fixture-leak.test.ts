import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFixtureLeaks, formatFixtureLeakWarning } from "../fixture-leak.js";
import { nonNull } from "../../lib/non-null.js";

// ===========================================
// detectFixtureLeaks
// ===========================================

describe("detectFixtureLeaks", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fix-leak-"));
		execSync("git init -q", { cwd: dir });
		execSync("git config user.email t@example.com", { cwd: dir });
		execSync("git config user.name Test", { cwd: dir });
		execSync("git commit --allow-empty -q -m initial", { cwd: dir });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function commitFile(path: string, content: string): void {
		const abs = join(dir, path);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
		execSync(`git add ${path}`, { cwd: dir });
		execSync('git commit -q -m "add"', { cwd: dir });
	}

	function writeUntracked(path: string, content: string): void {
		const abs = join(dir, path);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}

	// --- positive cases ---

	it("flags an untracked underscore-prefixed src file referenced by a test", () => {
		commitFile(
			"src/commands/__tests__/multi-edit.test.ts",
			'const FIXTURE = "_case_a.ts";\nfunction writeFixture(name, content) {}\n',
		);
		writeUntracked("src/lib/_case_a.ts", "export const X = 1;\n");

		const leaks = detectFixtureLeaks(dir);
		expect(leaks).toHaveLength(1);
		expect(nonNull(leaks[0]).file).toBe("src/lib/_case_a.ts");
		expect(nonNull(leaks[0]).referencedBy).toBe("src/commands/__tests__/multi-edit.test.ts");
	});

	it("flags multiple leaks each pointing at their source test", () => {
		commitFile(
			"src/commands/__tests__/multi-edit.test.ts",
			'const A = "_case_a.ts";\nconst B = "_case_b.ts";\nfunction writeFixture(){}\n',
		);
		writeUntracked("src/lib/_case_a.ts", "export const X = 1;\n");
		writeUntracked("src/lib/_case_b.ts", "export const Y = 2;\n");

		const leaks = detectFixtureLeaks(dir);
		expect(leaks).toHaveLength(2);
		expect(leaks.map((l) => l.file).sort()).toEqual([
			"src/lib/_case_a.ts",
			"src/lib/_case_b.ts",
		]);
	});

	it("recognizes alternate fixture-writer names (setupFixture, createFixture)", () => {
		commitFile(
			"src/__tests__/x.test.ts",
			'const F = "_a.ts";\nfunction setupFixture(){}\n',
		);
		commitFile(
			"src/__tests__/y.test.ts",
			'const G = "_b.ts";\nfunction createFixture(){}\n',
		);
		writeUntracked("src/lib/_a.ts", "x\n");
		writeUntracked("src/lib/_b.ts", "y\n");

		const leaks = detectFixtureLeaks(dir);
		expect(leaks.map((l) => l.file).sort()).toEqual(["src/lib/_a.ts", "src/lib/_b.ts"]);
	});

	// --- negative cases (FP avoidance) ---

	it("does NOT flag an untracked file with no test reference", () => {
		writeUntracked("src/lib/_random.ts", "export const X = 1;\n");
		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("does NOT flag tracked underscore-prefixed files (legitimate _shared modules)", () => {
		commitFile("src/lib/_shared.ts", "export const X = 1;\n");
		commitFile(
			"src/__tests__/foo.test.ts",
			'const F = "_shared.ts";\nfunction writeFixture(){}\n',
		);
		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("does NOT flag fixtures whose basename appears only in a comment (no writeFixture call)", () => {
		commitFile(
			"src/__tests__/notes.test.ts",
			"// see _case_a.ts for the canonical example\nexpect(true).toBe(true);\n",
		);
		writeUntracked("src/lib/_case_a.ts", "export const X = 1;\n");
		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("does NOT flag underscore-prefixed files outside src/", () => {
		commitFile(
			"src/__tests__/x.test.ts",
			'const F = "_case.ts";\nfunction writeFixture(){}\n',
		);
		writeUntracked("scripts/_case.ts", "x\n");
		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("does NOT flag files in src/ that lack an underscore prefix", () => {
		commitFile(
			"src/__tests__/x.test.ts",
			'const F = "case.ts";\nfunction writeFixture(){}\n',
		);
		writeUntracked("src/lib/case.ts", "x\n");
		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("returns empty when the cwd is not a git repo", () => {
		const nonRepo = mkdtempSync(join(tmpdir(), "no-repo-"));
		try {
			expect(detectFixtureLeaks(nonRepo)).toEqual([]);
		} finally {
			rmSync(nonRepo, { recursive: true, force: true });
		}
	});

	it("returns empty when there are no untracked files", () => {
		expect(detectFixtureLeaks(dir)).toEqual([]);
	});
});

// ===========================================
// formatFixtureLeakWarning
// ===========================================

describe("formatFixtureLeakWarning", () => {
	it("returns null when there are no leaks", () => {
		expect(formatFixtureLeakWarning({ leaks: [] })).toBeNull();
	});

	it("returns a warning string with the file and the referencing test", () => {
		const out = formatFixtureLeakWarning({
			leaks: [{ file: "src/lib/_a.ts", referencedBy: "src/x.test.ts" }],
		});
		expect(out).not.toBeNull();
		expect(out).toContain("[interlinked:fixture-leak]");
		expect(out).toContain("src/lib/_a.ts");
		expect(out).toContain("src/x.test.ts");
	});

	it("truncates with '...and N more' past maxShown", () => {
		const leaks = Array.from({ length: 7 }, (_, i) => ({
			file: `src/lib/_a${i}.ts`,
			referencedBy: "src/x.test.ts",
		}));
		const out = formatFixtureLeakWarning({ leaks });
		expect(out).toContain("...and 2 more");
	});

	it("honors a custom maxShown", () => {
		const leaks = Array.from({ length: 4 }, (_, i) => ({
			file: `src/lib/_a${i}.ts`,
			referencedBy: "src/x.test.ts",
		}));
		const out = formatFixtureLeakWarning({ leaks, maxShown: 2 });
		expect(out).toContain("...and 2 more");
	});
});
