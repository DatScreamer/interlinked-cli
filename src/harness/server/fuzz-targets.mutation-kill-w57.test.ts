import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectFuzzTargets } from "./fuzz-targets.js";

const FASTCHECK_IMPORT = `import fc from "fast-check";\n`;

let tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "fuzz-targets-w57-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tmpDirs = [];
});

describe("detectFuzzTargets — excluded directories", () => {
	// test-contract: bug — walk() skips node_modules/.git/dist; a false condition
	// here would leak generated/vendor test files into the fuzz-smoke target list.
	it("excludes node_modules, .git, and dist, but includes a real dir", () => {
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src", "node_modules"), { recursive: true });
		mkdirSync(join(cwd, "src", ".git"), { recursive: true });
		mkdirSync(join(cwd, "src", "dist"), { recursive: true });
		mkdirSync(join(cwd, "src", "real"), { recursive: true });
		writeFileSync(join(cwd, "src", "node_modules", "a.test.ts"), FASTCHECK_IMPORT);
		writeFileSync(join(cwd, "src", ".git", "b.test.ts"), FASTCHECK_IMPORT);
		writeFileSync(join(cwd, "src", "dist", "c.test.ts"), FASTCHECK_IMPORT);
		writeFileSync(join(cwd, "src", "real", "d.test.ts"), FASTCHECK_IMPORT);

		const result = detectFuzzTargets(cwd);
		expect(result).toEqual(["src/real/d.test.ts"]);
	});
});

describe("detectFuzzTargets — MAX_FILES_SCANNED budget", () => {
	// test-contract: boundary — the budget cap must stop the walk at exactly
	// MAX_FILES_SCANNED candidates so a huge tree can't stall SessionEnd.
	it("stops scanning at exactly 4000 candidate files", () => {
		const cwd = makeTmpDir();
		const srcDir = join(cwd, "src");
		mkdirSync(srcDir, { recursive: true });
		const total = 4001;
		for (let i = 0; i < total; i++) {
			writeFileSync(join(srcDir, `f${i}.test.ts`), FASTCHECK_IMPORT);
		}
		const result = detectFuzzTargets(cwd);
		expect(result.length).toBe(4000);
	}, 30000);
});

describe("detectFuzzTargets — .test.tsx suffix", () => {
	// test-contract: bug — walk() must match on endsWith(".test.tsx"), not
	// startsWith, so a real .test.tsx fuzz target isn't dropped.
	it("detects a fast-check file ending in .test.tsx", () => {
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "component.test.tsx"), FASTCHECK_IMPORT);

		const result = detectFuzzTargets(cwd);
		expect(result).toEqual(["src/component.test.tsx"]);
	});
});

describe("detectFuzzTargets — walk is scoped to <cwd>/src", () => {
	// test-contract: bug — detectFuzzTargets only walks join(cwd, "src"); a
	// file outside that root must never appear in the returned list.
	it("ignores a matching file outside src, includes one inside src", () => {
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src"), { recursive: true });
		// Outside src — must NOT be scanned.
		writeFileSync(join(cwd, "outside.test.ts"), FASTCHECK_IMPORT);
		// Inside src — must be found.
		writeFileSync(join(cwd, "src", "inside.test.ts"), FASTCHECK_IMPORT);

		const result = detectFuzzTargets(cwd);
		expect(result).toEqual(["src/inside.test.ts"]);
	});

	// test-contract: invariant — with no fast-check-driven file anywhere, the
	// returned array must be the fresh empty [] literal, not a pre-seeded one.
	it("returns [] when src has no fast-check files at all", () => {
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "plain.test.ts"), "export const x = 1;\n");

		const result = detectFuzzTargets(cwd);
		expect(result).toEqual([]);
	});
});

describe("detectFuzzTargets — backslash-to-slash normalization", () => {
	// test-contract: bug — relative(cwd, abs).replace(/\\/g, "/") must turn a
	// literal backslash character in the path into a forward slash.
	it("converts a literal backslash character in the relative path to a slash", () => {
		const cwd = makeTmpDir();
		const weirdDirName = "weird\\dir";
		mkdirSync(join(cwd, "src", weirdDirName), { recursive: true });
		writeFileSync(join(cwd, "src", weirdDirName, "e.test.ts"), FASTCHECK_IMPORT);

		const result = detectFuzzTargets(cwd);
		expect(result).toEqual(["src/weird/dir/e.test.ts"]);
	});
});

describe("detectFuzzTargets — FASTCHECK_RE boundary cases", () => {
	// test-contract: bug — FASTCHECK_RE's `from\s+` alternative must accept
	// one-or-more whitespace chars between "from" and the quoted module name.
	it("detects an import with two spaces before the quoted module name", () => {
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "import-spaces.test.ts"), `import fc from  'fast-check';\n`);

		const result = detectFuzzTargets(cwd);
		expect(result).toEqual(["src/import-spaces.test.ts"]);
	});

	// test-contract: bug — FASTCHECK_RE's call alternative uses `\s*\(`, which
	// must also match a call site with zero whitespace before the paren.
	it("detects fc.assert( called with no whitespace before the paren", () => {
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "assert-tight.test.ts"), `fc.assert(fc.property(fc.integer(), () => true));\n`);

		const result = detectFuzzTargets(cwd);
		expect(result).toEqual(["src/assert-tight.test.ts"]);
	});

	// test-contract: bug — the `\s*\(` call alternative must accept whitespace
	// characters before the paren, not just non-whitespace ones.
	it("detects fc.assert ( called with whitespace before the paren", () => {
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "assert-spaced.test.ts"), `fc.assert (someProp);\n`);

		const result = detectFuzzTargets(cwd);
		expect(result).toEqual(["src/assert-spaced.test.ts"]);
	});
});
