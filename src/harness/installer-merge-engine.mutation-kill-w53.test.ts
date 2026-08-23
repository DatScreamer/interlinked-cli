import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of node:fs so we can observe whether ensureDir calls mkdirSync
// at all (its own end-state — a directory existing — is identical whether or
// not mkdirSync ran, since `{ recursive: true }` is a no-op on an existing
// dir; the call itself is the only observable contract). Every other export
// stays the real implementation via importOriginal.
const mkdirSyncSpy = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
			mkdirSyncSpy(...args);
			return actual.mkdirSync(...args);
		},
	};
});

const { ensureDir, mergeSettings, readJson, removeJsonPath } = await import(
	"./installer-merge-engine.js"
);

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "installer-merge-engine-w53-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("mergeSettings — nextValue != null (must not always take object-merge branch)", () => {
	// test-contract: public-api — mergeSettings must write a scalar fragment
	// value directly (installer.ts contract: never clobber, but a missing
	// key gets the scalar as-is, not wrapped in an object-merge recursion).
	it("writes a scalar value directly instead of merging as an object (3e5068d6)", () => {
		const target: Record<string, unknown> = {};
		const fragment = { a: "hello" };
		const addedPaths: string[] = [];
		// SAFETY: test target only needs to satisfy the JsonObject index
		// shape mergeSettings mutates in place; a plain Record is equivalent.
		mergeSettings(target as any, fragment, "deep-merge", "", addedPaths);
		expect(target.a).toBe("hello");
	});

	// test-contract: boundary — a scalar `null` fragment value must also take
	// the scalar-write path (not the object-merge branch, which would instead
	// leave target.a pointing at a fresh {} / the recursive merge result).
	it("scalar null value is written as-is, not merged as an object (3e5068d6)", () => {
		const target: Record<string, unknown> = {};
		const fragment = { a: null };
		const addedPaths: string[] = [];
		// SAFETY: see above — plain Record satisfies the mutated-in-place shape.
		mergeSettings(target as any, fragment, "deep-merge", "", addedPaths);
		expect(target.a).toBeNull();
	});
});

describe("mergeSettings/readObjectField — existing-value guard (067c1abd)", () => {
	// test-contract: bug — readObjectField must discard a non-object existing
	// value and merge into a fresh {}, never cast the existing scalar itself
	// to JsonObject (which would corrupt/crash the recursive merge).
	it("replaces a non-object existing value with the merged fragment object (217c4b72, 7b765282)", () => {
		const target: Record<string, unknown> = { a: "existing string" };
		const fragment = { a: { b: 1 } };
		// SAFETY: plain Record satisfies the mutated-in-place shape mergeSettings needs.
		expect(() =>
			mergeSettings(target as any, fragment, "deep-merge", "", []),
		).not.toThrow();
		expect(target.a).toEqual({ b: 1 });
	});

	// test-contract: bug — an explicit `null` existing value must also be
	// treated as absent (fresh {} created), not passed through as a bogus
	// JsonObject that the recursive merge would then crash writing into.
	it("creates a fresh object when the existing value is null (619a681f)", () => {
		const target: Record<string, unknown> = { a: null };
		const fragment = { a: { b: 1 } };
		// SAFETY: plain Record satisfies the mutated-in-place shape mergeSettings needs.
		expect(() =>
			mergeSettings(target as any, fragment, "deep-merge", "", []),
		).not.toThrow();
		expect(target.a).toEqual({ b: 1 });
	});
});

describe("removeJsonPath — target guard (9e763b4b)", () => {
	// test-contract: public-api — removeJsonPath's documented contract is to
	// return false (not throw) for any structurally invalid target/path, so
	// a null target must short-circuit before any property access is attempted.
	it("returns false without throwing when target is null (1e2acf7e, e729ef03, 75f50f80)", () => {
		let result: boolean | undefined;
		expect(() => {
			result = removeJsonPath(null, "a");
		}).not.toThrow();
		expect(result).toBe(false);
	});

	// test-contract: boundary — index === array.length is one past the last
	// valid element; removeJsonPath must reject it (>=), not accept it (>).
	it("rejects an out-of-bounds index equal to array length (52aab13a)", () => {
		const target = { arr: [1, 2, 3] };
		const result = removeJsonPath(target, "arr[3]");
		expect(result).toBe(false);
		expect(target.arr).toEqual([1, 2, 3]);
	});

	// test-contract: public-api — sanity companion proving the in-bounds path
	// still succeeds, so the boundary test above is meaningful by contrast.
	it("removes a valid in-bounds array index (sanity companion)", () => {
		const target = { arr: [1, 2, 3] };
		const result = removeJsonPath(target, "arr[2]");
		expect(result).toBe(true);
		expect(target.arr).toEqual([1, 2]);
	});
});

describe("parsePath — index regex must capture multi-digit indices (ba6c2339)", () => {
	// test-contract: bug — a single-digit-only index regex silently drops the
	// `[10]` segment and falls back to treating "arr" as a bare key to delete,
	// destroying the whole array instead of splicing one element out of it.
	it("resolves a two-digit array index correctly, not falling back to a bare key", () => {
		const target = { arr: Array.from({ length: 13 }, (_, i) => i) };
		const result = removeJsonPath(target, "arr[10]");
		expect(result).toBe(true);
		// Correct behavior: only index 10 is spliced out, array shrinks by one
		// and the "arr" key itself is still present.
		expect(Object.prototype.hasOwnProperty.call(target, "arr")).toBe(true);
		expect(target.arr).toHaveLength(12);
		expect(target.arr).not.toContain(10);
	});
});

describe("step() guards inside removeJsonPath traversal (4eaf5637)", () => {
	// test-contract: security — dropping the array-typeof guard lets a dotted
	// key segment ("0") index into an array cursor via JS's permissive bracket
	// access, reaching into and deleting a property of an element it should
	// never have traversed into.
	it("refuses dot-key access into an array cursor (5235af5c, e7699c96c5b5)", () => {
		const target: Record<string, unknown> = { a: [{ c: "val" }] };
		const result = removeJsonPath(target, "a.0.c");
		expect(result).toBe(false);
		// SAFETY: target.a is constructed above as an array literal; the cast
		// only restates that shape for the assertion, no runtime effect.
		expect((target.a as any[])[0]).toEqual({ c: "val" });
	});

	// test-contract: security — dropping the !Array.isArray guard on an index
	// segment lets a bracket-index reach into a plain object cursor via bare
	// property access, deleting a nested property it should never have found.
	it("refuses index-style access into a non-array cursor (d2866f26)", () => {
		const target: Record<string, unknown> = { a: { 0: { c: "value" } } };
		const result = removeJsonPath(target, "a[0].c");
		expect(result).toBe(false);
		// SAFETY: target.a is constructed above as a plain object with a "0" key.
		expect((target.a as any)[0]).toEqual({ c: "value" });
	});

	// test-contract: security — dropping the typeof-object guard lets a
	// dotted key segment read an arbitrary property off a function cursor,
	// reaching a real nested object and deleting a property of it.
	it("refuses dot-key access into a non-object, non-array cursor (8dabbe4d)", () => {
		const fn: any = () => {};
		fn.b = { c: "val" };
		const target: Record<string, unknown> = { a: fn };
		const result = removeJsonPath(target, "a.b.c");
		expect(result).toBe(false);
		expect(fn.b).toEqual({ c: "val" });
	});
});

describe("readJson — encoding and null-content guards (eb4e1440)", () => {
	// test-contract: public-api — readJson must decode file bytes as utf-8;
	// an invalid encoding argument makes readFileSync throw, which readJson's
	// catch would then silently paper over as an empty object.
	it("reads file content using utf-8 decoding (41d0eda4)", () => {
		const file = join(dir, "config.json");
		writeFileSync(file, JSON.stringify({ a: 1 }), "utf-8");
		const result = readJson(file);
		expect(result).toEqual({ a: 1 });
	});

	// test-contract: invariant — readJson's declared return type is
	// JsonObject; parsed JSON `null` must be normalized to {}, never passed
	// through as the literal null value.
	it("returns {} rather than raw null when JSON content is literally 'null' (e2ed8ebd)", () => {
		const file = join(dir, "null.json");
		writeFileSync(file, "null", "utf-8");
		const result = readJson(file);
		expect(result).toEqual({});
		expect(result).not.toBeNull();
	});
});

describe("ensureDir — existence guard (9021b38d)", () => {
	// test-contract: public-api — ensureDir's `!existsSync(dir)` guard exists
	// specifically to avoid calling mkdirSync when the directory is already
	// present; the call itself (not just the end filesystem state, which is
	// identical either way under `recursive: true`) is the observable contract.
	it("does not call mkdirSync when the directory already exists (d09e9594)", () => {
		mkdirSyncSpy.mockClear();
		ensureDir(dir);
		expect(mkdirSyncSpy).not.toHaveBeenCalled();
	});

	// test-contract: public-api — sanity companion proving ensureDir still
	// creates a genuinely missing directory, so the guard test above is
	// meaningful by contrast rather than mkdirSync just never being reachable.
	it("creates a missing directory", () => {
		const target = join(dir, "nested", "deep");
		ensureDir(target);
		expect(fs.existsSync(target)).toBe(true);
	});
});
