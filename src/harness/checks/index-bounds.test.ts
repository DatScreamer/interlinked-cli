import { describe, expect, it } from "vitest";
import { checkIndexBoundsUnchecked } from "./index-bounds.js";

const TS = "src/handlers/users.ts";

describe("checkIndexBoundsUnchecked — positive cases", () => {
	it("flags inline Number(req.body.idx) as array index", () => {
		const code = [
			"function handler(req: any, rows: number[]) {",
			"  return rows[Number(req.body.idx)];",
			"}",
		].join("\n");
		const out = checkIndexBoundsUnchecked(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags inline parseInt(req.params.id) as array index", () => {
		const code = [
			"function handler(req: any, rows: any[]) {",
			"  return rows[parseInt(req.params.id, 10)];",
			"}",
		].join("\n");
		const out = checkIndexBoundsUnchecked(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags two-step parseInt(req.params.id) -> arr[n] without guard", () => {
		const code = [
			"function handler(req: any, rows: any[]) {",
			"  const id = parseInt(req.params.id, 10);",
			"  return rows[id];",
			"}",
		].join("\n");
		const out = checkIndexBoundsUnchecked(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags Number(process.argv[2]) used as index", () => {
		const code = [
			"function main(rows: any[]) {",
			"  const i = Number(process.argv[2]);",
			"  console.log(rows[i]);",
			"}",
		].join("\n");
		const out = checkIndexBoundsUnchecked(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags Number(req.query.page) used as index in same fn", () => {
		const code = [
			"function get(req: any, rows: any[]) {",
			"  const page = Number(req.query.page);",
			"  return rows[page];",
			"}",
		].join("\n");
		const out = checkIndexBoundsUnchecked(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkIndexBoundsUnchecked — negative cases (must NOT fire)", () => {
	it("ignores stable literal indices", () => {
		const code = [
			"function ok(rows: any[]) {",
			"  return rows[0];",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	it("ignores loop-bound variables (no external-input parse)", () => {
		const code = [
			"function ok(rows: any[]) {",
			"  for (let i = 0; i < rows.length; i++) {",
			"    console.log(rows[i]);",
			"  }",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	it("ignores when Number.isFinite guard precedes the access", () => {
		const code = [
			"function ok(req: any, rows: any[]) {",
			"  const n = Number(req.body.idx);",
			"  if (!Number.isFinite(n) || n < 0 || n >= rows.length) return null;",
			"  return rows[n];",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	it("ignores when length-bound guard precedes the access", () => {
		const code = [
			"function ok(req: any, rows: any[]) {",
			"  const n = parseInt(req.params.id, 10);",
			"  if (n < rows.length && n >= 0) return rows[n];",
			"  return null;",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	it("ignores when parsed value is used outside index context", () => {
		const code = [
			"function ok(req: any) {",
			"  const id = parseInt(req.params.id, 10);",
			"  return { id };",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	it("ignores parses with no external-input source", () => {
		const code = [
			"function ok(rows: any[]) {",
			'  const n = parseInt("0", 10);',
			"  return rows[n];",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});
});
