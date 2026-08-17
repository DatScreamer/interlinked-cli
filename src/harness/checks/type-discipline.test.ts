// Check Evidence Contract cases for type-discipline.ts +
// type-discipline-unknown-alias.ts (advisory, post-phase). Labeled with the
// P<n>:/N<n>: prefix convention recognized by check-evidence/case-parser.ts
// — see CLAUDE.md "Check Evidence Contract".
//
// conditional_empty_object_spread needs >=1/1 (post/advisory minimum); ships
// with 4 positive / 15 negative (N9-N15 lock in the widened guard-shape
// exemption added after the corpus scan — see type-discipline.ts's header).
// unknown_type_alias same tier; ships with 4 positive / 5 negative.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { detectUnknownTypeAlias } from "./type-discipline-unknown-alias.js";
import { detectConditionalEmptyObjectSpread } from "./type-discipline.js";

const TS_FILE = "src/lib/data.ts";
const JS_FILE = "src/lib/data.js";
const JSX_FILE = "src/components/widget.jsx";

// ═══════════════════════════════════════════════════════════════════════
// conditional_empty_object_spread
// ═══════════════════════════════════════════════════════════════════════

describe("detectConditionalEmptyObjectSpread — positive cases (must fire)", () => {
	it("P1: fires when the empty object is the ternary's true branch", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/conditional empty-object spread/);
	});

	it("P2: fires when the empty object is the ternary's false branch (mirror image)", () => {
		const content = "const a = { ...(!cond ? { field: value } : {}) };";
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings.length).toBe(1);
	});

	it("P3: fires even when the non-empty branch has multiple fields", () => {
		const content = "const a = { ...(cond ? {} : { x: 1, y: 2 }) };";
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings.length).toBe(1);
	});

	it("P4: fires on a multi-line spread nested inside a return statement", () => {
		const content = `
function build(cond: boolean) {
  return {
    base: 1,
    ...(cond ? { extra: true } : {}),
  };
}
`.trim();
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(4);
	});
});

describe("detectConditionalEmptyObjectSpread — negative cases (must not fire)", () => {
	it("N1: does not fire on an unconditional spread", () => {
		const content = "const a = { ...base };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N2: does not fire when neither ternary branch is an empty object", () => {
		const content = "const a = { ...(cond ? { x: 1 } : { y: 2 }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N3: does not fire when the ternary is not spread at all", () => {
		const content = "const a = cond ? {} : { x: 1 };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N4: does not fire on an array spread (SpreadElement, not SpreadAssignment)", () => {
		const content = "const a = [...(cond ? [] : [1])];";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N5: does not fire on a logical-AND spread (not a ConditionalExpression)", () => {
		const content = "const a = { ...(cond && { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N6: does not fire on the idiomatic exactOptionalPropertyTypes key-omission shape (!== undefined)", () => {
		const content = "const a = { ...(opts.json !== undefined ? { json: opts.json } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N7: does not fire on the branch-swapped mirror (=== undefined)", () => {
		const content = "const a = { ...(opts.json === undefined ? {} : { json: opts.json }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N8: does not fire on the shorthand-property form of the key-omission shape", () => {
		const content = "const a = { ...(json !== undefined ? { json } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	// Corpus-shaped: scratch/type-discipline-corpus-scan.mts found these guard
	// variants (bare truthy, negated, typeof, .length/.size) after the
	// strict-undefined exemption alone still left 106 fires. Real examples
	// (trimmed) from src/lib/config.ts, src/lib/local-activity.ts,
	// src/lib/collection/builder.ts, src/harness/coverage-runner-failing-tests.ts.
	it("N9: does not fire on a bare truthy-identifier guard with a renamed key", () => {
		const content = "const a = { ...(mergedServers ? { servers: mergedServers } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N10: does not fire on a bare truthy-identifier guard with shorthand property", () => {
		const content = "const a = { ...(toolCall ? { toolCall } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N11: does not fire on the negated form (populated branch on whenFalse)", () => {
		const content = "const a = { ...(!cleanupError ? {} : { error: cleanupError }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N12: does not fire on a typeof-narrowing guard", () => {
		const content = "const a = { ...(typeof ts === \"string\" ? { ts } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N13: does not fire on a .length non-empty guard", () => {
		const content = "const a = { ...result, ...(cappedNames.length > 0 ? { failingTests: cappedNames } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N14: does not fire on a .size non-empty guard", () => {
		const content = "const a = { ...(items.size > 0 ? { items } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N15: does not fire when the guard uses ?. and the value uses . (same proven-safe path)", () => {
		const content =
			"const a = { ...(existingShared?.mode ? { mode: existingShared.mode } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("still fires when the checked expression and the property VALUE differ (not a passthrough)", () => {
		const content = "const a = { ...(opts.json !== undefined ? { enabled: true } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	it("still fires on a loose-equality undefined check (not the strict guard shape)", () => {
		const content = "const a = { ...(opts.json != undefined ? { json: opts.json } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	it("still fires on a bare truthy guard whose value does not match the guard (unrelated field)", () => {
		const content = "const a = { ...(cond ? { key: somethingElse } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	it("still fires on a .length guard whose populated branch has multiple fields", () => {
		const content =
			"const a = { ...(covered.size > 0 || uncovered.size > 0 ? { coveredLines: covered, uncoveredLines: uncovered } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	it("still fires when the populated branch's value is a composed expression, not the guarded one", () => {
		const content = "const a = { ...(options.env ? { env: { ...process.env, ...options.env } } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});
});

describe("detectConditionalEmptyObjectSpread — scope and limits", () => {
	it("runs on plain JS files too (the pattern is not TS-specific)", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, JS_FILE).length).toBe(1);
	});

	it("runs on JSX files", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, JSX_FILE).length).toBe(1);
	});

	it("skips non-JS/TS extensions entirely", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, "README.md")).toEqual([]);
	});

	it("skips test files", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, "src/lib/data.test.ts")).toEqual([]);
	});

	it("skips empty content", () => {
		expect(detectConditionalEmptyObjectSpread("", TS_FILE)).toEqual([]);
	});

	it("caps at 10 matches per file even with more offending spreads than that", () => {
		const lines = Array.from(
			{ length: 12 },
			(_, i) => `const c${i} = { ...(cond ? {} : { x: ${i} }) };`,
		);
		const findings = detectConditionalEmptyObjectSpread(lines.join("\n"), TS_FILE);
		expect(findings.length).toBe(10);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// unknown_type_alias
// ═══════════════════════════════════════════════════════════════════════

describe("detectUnknownTypeAlias — positive cases (must fire)", () => {
	it("P1: fires on a bare alias to unknown", () => {
		const content = "type Foo = unknown;";
		const findings = detectUnknownTypeAlias(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/only renames 'unknown'/);
	});

	it("P2: fires through a same-file, non-generic alias chain (both links)", () => {
		const content = ["type Foo = unknown;", "type Bar = Foo;"].join("\n");
		const findings = detectUnknownTypeAlias(content, TS_FILE);
		expect(findings.length).toBe(2);
		expect(findings.map((f) => f.line).sort()).toEqual([1, 2]);
	});

	it("P3: fires through a parenthesized unknown", () => {
		const content = "type Foo = (unknown);";
		expect(detectUnknownTypeAlias(content, TS_FILE).length).toBe(1);
	});

	it("P4: fires on an exported alias", () => {
		const content = "export type Foo = unknown;";
		expect(detectUnknownTypeAlias(content, TS_FILE).length).toBe(1);
	});
});

describe("detectUnknownTypeAlias — negative cases (must not fire)", () => {
	it("N1: does not fire on an alias to a concrete type", () => {
		expect(detectUnknownTypeAlias("type Foo = string;", TS_FILE)).toEqual([]);
	});

	it("N2: does not fire on Record<string, unknown> (a generic instantiation, not an alias to unknown)", () => {
		const content = "type Foo = Record<string, unknown>;";
		expect(detectUnknownTypeAlias(content, TS_FILE)).toEqual([]);
	});

	it("N3: does not fire through a generic alias reference (parameterized, not a bare rename)", () => {
		const content = ["type ID<T> = T;", "type UserId = ID<string>;"].join("\n");
		expect(detectUnknownTypeAlias(content, TS_FILE)).toEqual([]);
	});

	it("N4: does not fire when the alias NAME contains 'unknown' but the type does not", () => {
		const content = "type UnknownFields = { [key: string]: string };";
		expect(detectUnknownTypeAlias(content, TS_FILE)).toEqual([]);
	});

	it("N5: does not fire on a union that merely includes unknown", () => {
		const content = "type Foo = string | unknown;";
		expect(detectUnknownTypeAlias(content, TS_FILE)).toEqual([]);
	});
});

describe("detectUnknownTypeAlias — scope and limits", () => {
	it("skips non-TS extensions (type aliases don't exist in plain JS)", () => {
		expect(detectUnknownTypeAlias("type Foo = unknown;", JS_FILE)).toEqual([]);
	});

	it("skips test files", () => {
		expect(detectUnknownTypeAlias("type Foo = unknown;", "src/lib/data.test.ts")).toEqual([]);
	});

	it("skips empty content", () => {
		expect(detectUnknownTypeAlias("", TS_FILE)).toEqual([]);
	});

	it("caps at 10 matches per file even with more offending aliases than that", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `type Foo${i} = unknown;`);
		const findings = detectUnknownTypeAlias(lines.join("\n"), TS_FILE);
		expect(findings.length).toBe(10);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// AST-availability degrade — mirrors correctness-misc.test.ts's convention
// ═══════════════════════════════════════════════════════════════════════

describe("type-discipline — optional 'typescript' dep unavailable", () => {
	afterEach(() => {
		vi.doUnmock("node:module");
		vi.resetModules();
	});

	it("both detectors return [] when 'typescript' cannot be required", async () => {
		vi.resetModules();
		vi.doMock("node:module", () => ({
			createRequire: () => () => {
				throw new Error("cannot find module 'typescript'");
			},
		}));
		const spreadMod = await import("./type-discipline.js");
		const aliasMod = await import("./type-discipline-unknown-alias.js");
		const spreadContent = "const a = { ...(cond ? {} : { field: value }) };";
		const aliasContent = "type Foo = unknown;";
		expect(spreadMod.detectConditionalEmptyObjectSpread(spreadContent, TS_FILE)).toEqual([]);
		expect(aliasMod.detectUnknownTypeAlias(aliasContent, TS_FILE)).toEqual([]);
	});

	it("both detectors return [] when ts.createSourceFile throws (parse failure is swallowed)", async () => {
		vi.resetModules();
		const real = (await vi.importActual("typescript")) as Record<string, unknown>;
		vi.doMock("node:module", () => ({
			createRequire: () => () => ({
				...real,
				createSourceFile: () => {
					throw new Error("synthetic parse failure");
				},
			}),
		}));
		const spreadMod = await import("./type-discipline.js");
		const aliasMod = await import("./type-discipline-unknown-alias.js");
		const spreadContent = "const a = { ...(cond ? {} : { field: value }) };";
		const aliasContent = "type Foo = unknown;";
		expect(spreadMod.detectConditionalEmptyObjectSpread(spreadContent, TS_FILE)).toEqual([]);
		expect(aliasMod.detectUnknownTypeAlias(aliasContent, TS_FILE)).toEqual([]);
	});
});
