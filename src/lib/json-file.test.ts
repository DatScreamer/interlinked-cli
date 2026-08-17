import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJsonFile, readJsonObject } from "./json-file.js";

let dir = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "json-file-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
	const path = join(dir, name);
	writeFileSync(path, contents, "utf-8");
	return path;
}

describe("readJsonFile", () => {
	it("parses an object file", () => {
		const path = write("obj.json", '{"a":1}');
		expect(readJsonFile<{ a: number }>(path)).toEqual({ a: 1 });
	});

	it("parses a non-object JSON value (no narrowing)", () => {
		expect(readJsonFile<number[]>(write("arr.json", "[1,2]"))).toEqual([1, 2]);
		expect(readJsonFile<number>(write("num.json", "7"))).toBe(7);
	});

	it("returns null for a missing file", () => {
		expect(readJsonFile(join(dir, "does-not-exist.json"))).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(readJsonFile(write("bad.json", "{not json"))).toBeNull();
	});

	it("returns null for a directory path", () => {
		expect(readJsonFile(dir)).toBeNull();
	});

	it("decodes UTF-8 content", () => {
		expect(readJsonFile<{ s: string }>(write("utf8.json", '{"s":"é☃"}'))).toEqual({ s: "é☃" });
	});
});

describe("readJsonObject", () => {
	it("parses an object file", () => {
		expect(readJsonObject(write("obj-two.json", '{"a":1}'))).toEqual({ a: 1 });
	});

	it("returns null for an array", () => {
		expect(readJsonObject(write("a2.json", "[1,2]"))).toBeNull();
	});

	it("returns null for a JSON primitive or null literal", () => {
		expect(readJsonObject(write("p2.json", '"hello"'))).toBeNull();
		expect(readJsonObject(write("n2.json", "null"))).toBeNull();
	});

	it("returns null for a missing file", () => {
		expect(readJsonObject(join(dir, "nope.json"))).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(readJsonObject(write("bad2.json", "{"))).toBeNull();
	});
});
