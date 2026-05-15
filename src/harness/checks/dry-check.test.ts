import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCodeClones } from "./dry-check.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dry-check-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const cloneBody = `{
	const out = [];
	for (const row of rows) {
		if (row.enabled) {
			out.push(row.value);
		}
	}
	return out;
}`;

describe("checkCodeClones", () => {
	it("flags two near-identical functions in the same file", () => {
		const content = `
function collectA(rows: Row[]): number[] ${cloneBody}
function collectB(rows: Row[]): number[] ${cloneBody}
`;
		const file = join(dir, "collect.ts");
		writeFileSync(file, content);
		const matches = checkCodeClones(content, file);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(matches[0].text).toContain("similar to");
	});

	it("flags a clone living in a sibling file", () => {
		const editedContent = `
function collectA(rows: Row[]): number[] ${cloneBody}
`;
		const siblingContent = `
function collectZ(rows: Row[]): number[] ${cloneBody}
`;
		const editedFile = join(dir, "a.ts");
		const siblingFile = join(dir, "b.ts");
		writeFileSync(editedFile, editedContent);
		writeFileSync(siblingFile, siblingContent);
		const matches = checkCodeClones(editedContent, editedFile);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("b.ts");
	});

	it("returns [] for non-JS/TS files", () => {
		expect(checkCodeClones("whatever", join(dir, "notes.md"))).toEqual([]);
	});

	it("returns [] for files with no duplicated functions", () => {
		const content = `
function uniqueOne(x: number): number {
	const a = x + 1;
	const b = a * 2;
	const c = b - 3;
	return c;
}
`;
		const file = join(dir, "unique.ts");
		writeFileSync(file, content);
		expect(checkCodeClones(content, file)).toEqual([]);
	});
});
