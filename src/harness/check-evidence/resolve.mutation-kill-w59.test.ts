import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles, buildDetectorIndex, resolveDetector, type DetectorIndex } from "./resolve.js";

describe("walkFiles — positive (must fire)", () => {
	it("P1: returns an empty array (not a padded default) when nothing matches", () => {
		const root = mkdtempSync(join(tmpdir(), "walkfiles-empty-"));
		try {
			const result = walkFiles(root, () => false);
			expect(result).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("P2: a broken symlink is treated as neither dir nor file — never pushed even when predicate always true", () => {
		const root = mkdtempSync(join(tmpdir(), "walkfiles-symlink-"));
		try {
			symlinkSync(join(root, "does-not-exist.ts"), join(root, "broken-link.ts"));
			const result = walkFiles(root, () => true);
			expect(result).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("buildDetectorIndex / resolveDetector — positive and negative (must fire correctly)", () => {
	let root = "";
	let idx: DetectorIndex;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "detector-index-"));

		// exportedNames regex fixtures: one line per nuance.
		writeFileSync(
			join(root, "regexFixture.ts"),
			[
				"export  const doubleSpaceAfterExport = 1;",
				"  export const indented = 1;",
				"xexport const midline = 1;",
				"export async function asyncFn(){}",
				"export async  function asyncTwoSpaces(){}",
				"export function  spacedName(){}",
				"",
			].join("\n"),
		);

		// First-writer-wins: a root-level file must be discovered before a nested one.
		writeFileSync(join(root, "aTop.ts"), "export function dupDetectorName(){}\n");
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "bNested.ts"), "export function dupDetectorName(){}\n");

		// attributeTests: two distinct test files referencing the same detector name.
		mkdirSync(join(root, "attrib"));
		writeFileSync(join(root, "attrib", "detector.ts"), "export function myDetectorForAttrib(){}\n");
		writeFileSync(join(root, "attrib", "test1.test.ts"), "myDetectorForAttrib();\n");
		writeFileSync(join(root, "attrib", "test2.test.ts"), "myDetectorForAttrib();\n");

		// attributeTests: an identifier referenced in a test file but never exported anywhere.
		mkdirSync(join(root, "unrelated"));
		writeFileSync(join(root, "unrelated", "random.test.ts"), "const zzzUnregisteredIdentifierXyz = 1;\n");

		// SOURCE_EXT_RE / predicate: non-.ts files must never be scanned at all.
		mkdirSync(join(root, "txtCheck"));
		writeFileSync(join(root, "txtCheck", "note.txt"), "export function shouldNeverAppearFromTxt(){}\n");
		writeFileSync(join(root, "txtCheck", "included.ts.txt"), "export function notFoundInTxtFile(){}\n");

		// .d.ts exclusion.
		mkdirSync(join(root, "dtsCheck"));
		writeFileSync(join(root, "dtsCheck", "foo.d.ts"), "export const dtsExportedName = 1;\n");

		// SKIP_DIRS literals.
		mkdirSync(join(root, "skipDirsCheck"));
		mkdirSync(join(root, "skipDirsCheck", "__fixtures__"));
		writeFileSync(
			join(root, "skipDirsCheck", "__fixtures__", "fixtureOnly.ts"),
			"export function fixtureOnlyDetector(){}\n",
		);
		mkdirSync(join(root, "skipDirsCheck", ".git"));
		writeFileSync(join(root, "skipDirsCheck", ".git", "gitOnly.ts"), "export function gitOnlyDetector(){}\n");
		mkdirSync(join(root, "skipDirsCheck", "coverage"));
		writeFileSync(
			join(root, "skipDirsCheck", "coverage", "coverageOnly.ts"),
			"export function coverageOnlyDetector(){}\n",
		);

		// TEST_SUFFIX_RE end-anchor: must NOT match a filename that merely contains
		// ".test.tsx" somewhere but doesn't end with it.
		mkdirSync(join(root, "testSuffixCheck"));
		writeFileSync(
			join(root, "testSuffixCheck", "abc.test.tsx-extra.ts"),
			"export function specialTestSuffixDetector(){}\n",
		);

		// text === null guard: an unreadable test file must be skipped entirely,
		// not silently coerced into the string "null".
		mkdirSync(join(root, "permCheck"));
		writeFileSync(join(root, "permCheck", "detectorNull.ts"), "export const null = 1;\n");
		const brokenTestFile = join(root, "permCheck", "broken.test.ts");
		writeFileSync(brokenTestFile, "irrelevant content\n");
		chmodSync(brokenTestFile, 0o000);

		idx = buildDetectorIndex({ searchRoot: root, repoRoot: root });
	});

	afterAll(() => {
		try {
			chmodSync(join(root, "permCheck", "broken.test.ts"), 0o644);
		} catch (err) {
			// interlinked-ignore: empty_catch — cleanup best-effort; recursive rmSync below still runs
			void err;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("P3: names array starts empty — no phantom 'Stryker was here' entry", () => {
		expect(resolveDetector(idx, "Stryker was here").detectorFile).toBeNull();
	});

	it("P4: export\\s+ after 'export' consumes more than one space", () => {
		expect(resolveDetector(idx, "doubleSpaceAfterExport").detectorFile).not.toBeNull();
	});

	it("P5: ^\\s* consumes leading indentation before 'export'", () => {
		expect(resolveDetector(idx, "indented").detectorFile).not.toBeNull();
	});

	it("N1: ^ anchors to line start — 'xexport' must not match mid-line", () => {
		expect(resolveDetector(idx, "midline").detectorFile).toBeNull();
	});

	it("P6: (?:async\\s+)? matches with exactly one space after async", () => {
		expect(resolveDetector(idx, "asyncFn").detectorFile).not.toBeNull();
	});

	it("P7: (?:async\\s+)? consumes more than one space after async", () => {
		expect(resolveDetector(idx, "asyncTwoSpaces").detectorFile).not.toBeNull();
	});

	it("P8: trailing \\s+ before the captured name consumes more than one space", () => {
		expect(resolveDetector(idx, "spacedName").detectorFile).not.toBeNull();
	});

	it("P9: first writer wins — a root-level file is discovered before a nested one", () => {
		expect(resolveDetector(idx, "dupDetectorName").detectorFile).toBe("aTop.ts");
	});

	it("P10: a detector referenced by two distinct test files keeps both, not just the last", () => {
		const { testFiles } = resolveDetector(idx, "myDetectorForAttrib");
		expect(testFiles.sort()).toEqual([join("attrib", "test1.test.ts"), join("attrib", "test2.test.ts")].sort());
	});

	it("N2: an identifier with no matching export is never attributed to a test file", () => {
		expect(resolveDetector(idx, "zzzUnregisteredIdentifierXyz").testFiles).toEqual([]);
	});

	it("N3: a .txt file is never scanned for exports at all", () => {
		expect(resolveDetector(idx, "shouldNeverAppearFromTxt").detectorFile).toBeNull();
	});

	it("N4: SOURCE_EXT_RE is end-anchored — a '.ts' substring mid-filename does not count", () => {
		expect(resolveDetector(idx, "notFoundInTxtFile").detectorFile).toBeNull();
	});

	it("N5: a .d.ts file is excluded even though it passes the .ts extension check", () => {
		expect(resolveDetector(idx, "dtsExportedName").detectorFile).toBeNull();
	});

	it("N6: __fixtures__ directories are never scanned", () => {
		expect(resolveDetector(idx, "fixtureOnlyDetector").detectorFile).toBeNull();
	});

	it("N7: .git directories are never scanned", () => {
		expect(resolveDetector(idx, "gitOnlyDetector").detectorFile).toBeNull();
	});

	it("N8: coverage directories are never scanned", () => {
		expect(resolveDetector(idx, "coverageOnlyDetector").detectorFile).toBeNull();
	});

	it("P11: TEST_SUFFIX_RE is end-anchored — a filename that merely contains '.test.tsx' still resolves as a source file", () => {
		expect(resolveDetector(idx, "specialTestSuffixDetector").detectorFile).not.toBeNull();
	});

	it("N9: an unreadable test file is skipped, not stringified to \"null\" and attributed", () => {
		expect(resolveDetector(idx, "null").testFiles).toEqual([]);
	});
});
