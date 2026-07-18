// Companion tests for edit-doom.ts (LG-1/LG-2 — edit-contract-hardening.md).
// Positive cases prove each doom class fires with one-round-trip rescue
// material; negative cases prove the client stays the authority everywhere
// we cannot decide with certainty (fail-open).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeApplyPatchDoom, analyzeStrReplaceDoom, formatDoomReason } from "./edit-doom.js";

let dir: string;
let target: string;

const FILE_CONTENT = [
	"function greet(name) {",
	'  const msg = "Hello, " + name;',
	"  console.log(msg);",
	"}",
	"const tail = 1;",
	"const tail = 1;",
	"",
].join("\n");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "edit-doom-"));
	target = join(dir, "sample.js");
	writeFileSync(target, FILE_CONTENT);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("analyzeStrReplaceDoom — missing anchor", () => {
	it("dooms a bare Edit whose old_string is absent", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: 'const msg = "Hello " + name;', // comma missing vs file
			new_string: "x",
		});
		expect(doom?.kind).toBe("missing");
		expect(doom?.entryIndex).toBe(1);
		expect(doom?.entryCount).toBe(1);
	});

	it("renders the rescue with verbatim current content and no re-read demand", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: 'const msg = "Hello " + name;',
			new_string: "x",
		});
		expect(doom).not.toBeNull();
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).toMatch(/old_string not found/);
		expect(reason).toContain('  const msg = "Hello, " + name;'); // exact whitespace
		expect(reason).toContain("```");
		expect(reason).not.toMatch(/Re-read the file first/);
	});

	it("dooms the correct MultiEdit entry against post-earlier-entry content", () => {
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [
				{ old_string: "function greet(name) {", new_string: "function greet(who) {" },
				// Entry 2 still references the ORIGINAL signature entry 1 replaced.
				{ old_string: "function greet(name) {", new_string: "function hi(name) {" },
			],
		});
		expect(doom?.kind).toBe("missing");
		expect(doom?.entryIndex).toBe(2);
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).toMatch(/entry 2 of 2/);
		expect(reason).toMatch(/MultiEdit is atomic — nothing was applied/);
	});
});

describe("analyzeStrReplaceDoom — ambiguous anchor", () => {
	it("dooms a multi-match old_string without replace_all and lists sites", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "const tail = 1;",
			new_string: "const tail = 2;",
		});
		expect(doom?.kind).toBe("ambiguous");
		expect(doom?.occurrenceLines).toEqual([5, 6]);
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).toMatch(/matches 2 times/);
		expect(reason).toMatch(/replace_all: true/);
	});

	it("suggests a unique widened anchor when one exists", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "const tail = 1;",
			new_string: "x",
		});
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		// Widening the first site downward reaches the second duplicate line,
		// which uniquifies (the pair only occurs once).
		expect(reason).toMatch(/unique anchor exists/);
		expect(reason).toContain("const tail = 1;\nconst tail = 1;");
	});
});

describe("analyzeStrReplaceDoom — fail-open negatives", () => {
	it("returns null when the old_string is present exactly once", () => {
		expect(
			analyzeStrReplaceDoom("Edit", {
				file_path: target,
				old_string: "console.log(msg);",
				new_string: "console.warn(msg);",
			}),
		).toBeNull();
	});

	it("returns null for a multi-match WITH replace_all", () => {
		expect(
			analyzeStrReplaceDoom("Edit", {
				file_path: target,
				old_string: "const tail = 1;",
				new_string: "const tail = 2;",
				replace_all: true,
			}),
		).toBeNull();
	});

	it("does not doom a MultiEdit entry whose anchor is created by an earlier entry", () => {
		expect(
			analyzeStrReplaceDoom("MultiEdit", {
				file_path: target,
				edits: [
					{ old_string: "console.log(msg);", new_string: "report(msg);" },
					{ old_string: "report(msg);", new_string: "report(msg, true);" },
				],
			}),
		).toBeNull();
	});

	it("returns null for a nonexistent file, foreign shapes, and foreign tools", () => {
		expect(
			analyzeStrReplaceDoom("Edit", {
				file_path: join(dir, "absent.js"),
				old_string: "x",
				new_string: "y",
			}),
		).toBeNull();
		expect(analyzeStrReplaceDoom("Edit", { file_path: target })).toBeNull();
		expect(
			analyzeStrReplaceDoom("Write", { file_path: target, old_string: "a", new_string: "b" }),
		).toBeNull();
	});
});

describe("analyzeApplyPatchDoom", () => {
	const patchFor = (body: string[]): string =>
		["*** Begin Patch", `*** Update File: ${target}`, ...body, "*** End Patch"].join("\n");

	it("warns when hunk context does not match the live file, with rescue", () => {
		const dooms = analyzeApplyPatchDoom("apply_patch", {
			command: patchFor([" function greet(nom) {", "-  console.log(msg);", "+  console.warn(msg);"]),
		});
		expect(dooms).toHaveLength(1);
		expect(dooms[0]?.path).toBe(target);
		expect(dooms[0]?.warning).toMatch(/apply-patch-doom/);
		expect(dooms[0]?.warning).toMatch(/does not match the live file/);
		expect(dooms[0]?.warning).toContain("function greet(name) {");
	});

	it("warns when the update targets a missing file", () => {
		const missing = join(dir, "gone.js");
		const dooms = analyzeApplyPatchDoom("apply_patch", {
			command: [
				"*** Begin Patch",
				`*** Update File: ${missing}`,
				" a",
				"-b",
				"+c",
				"*** End Patch",
			].join("\n"),
		});
		expect(dooms).toHaveLength(1);
		expect(dooms[0]?.warning).toMatch(/does not exist/);
	});

	it("stays silent when the patch applies cleanly", () => {
		const warnings = analyzeApplyPatchDoom("apply_patch", {
			command: patchFor([
				" function greet(name) {",
				'   const msg = "Hello, " + name;',
				"-  console.log(msg);",
				"+  console.warn(msg);",
			]),
		});
		expect(warnings).toEqual([]);
	});

	it("stays silent for non-apply_patch tools and empty payloads", () => {
		expect(analyzeApplyPatchDoom("Edit", { command: "x" })).toEqual([]);
		expect(analyzeApplyPatchDoom("apply_patch", {})).toEqual([]);
	});
});
