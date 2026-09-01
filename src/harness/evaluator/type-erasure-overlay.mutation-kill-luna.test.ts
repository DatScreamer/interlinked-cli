import { describe, expect, it } from "vitest";
import { evaluateTypeErasureOverlay } from "./type-erasure-overlay.js";

describe("type-erasure overlay mutation contracts", () => {
	// test-contract: boundary — only a complete TypeScript-family suffix is eligible for this overlay.
	it("rejects a TypeScript-looking path with a trailing suffix", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/feature.ts.backup",
			"const value = input as any;",
			{ preContent: "" },
		);
		expect(result).toEqual({ newFindings: [], applicable: false });
	});

	// test-contract: invariant — an inline directive justification accepts each supported separator form without requiring a space.
	it("accepts a colon, hyphen, or em dash directly before a justification", () => {
		for (const separator of [":", "-", "—"]) {
			const result = evaluateTypeErasureOverlay(
				"/tmp/overlay.ts",
				`// @ts-ignore${separator}third-party declaration is inaccurate\n`,
				{ preContent: "" },
			);
			expect(result.newFindings).toEqual([]);
		}
	});

	// test-contract: boundary — whitespace between the separator and explanation is optional, but multiple spaces remain valid.
	it("accepts one or multiple spaces before an inline justification", () => {
		for (const spacing of [" ", "  "]) {
			const result = evaluateTypeErasureOverlay(
				"/tmp/overlay.ts",
				`// @ts-ignore:${spacing}third-party declaration is inaccurate\n`,
				{ preContent: "" },
			);
			expect(result.newFindings).toEqual([]);
		}
	});

	// test-contract: boundary — a separator followed only by whitespace is not a justification.
	it("does not treat separator-only trailing whitespace as a justification", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/overlay.ts",
			"// @ts-ignore:   \n",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.ruleId).toBe("unjustified_ts_directive");
	});

	// test-contract: invariant — a type alias is exempt only when the alias declaration starts the line after indentation.
	it("recognizes the complete family of type-alias spellings", () => {
		const aliases = [
			"type AliasName = { value: any };",
			"  type AliasName = { value: any };",
			"export type AliasName = { value: any };",
			"export   type AliasName = { value: any };",
			"type  AliasName = { value: any };",
			"type AliasName   = { value: any };",
		];
		for (const alias of aliases) {
			const result = evaluateTypeErasureOverlay("/tmp/overlay.ts", alias, {
				preContent: "",
			});
			expect(result.newFindings).toEqual([]);
		}
	});

	// test-contract: boundary — a bare annotation after code on the same line is not itself a type-alias declaration.
	it("does not exempt an indented alias-like fragment after a code prefix", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/overlay.ts",
			"if (ready) { const value: any = input; }",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.ruleId).toBe("bare_any_annotation");
	});

	// test-contract: invariant — production findings preserve their public location, rule, message, and stable key.
	it("reports an exact finding shape for a match at the start of a line", () => {
		const result = evaluateTypeErasureOverlay("/tmp/overlay.ts", "as any\n", {
			preContent: "",
		});
		expect(result.newFindings).toEqual([
			{
				line: 1,
				column: 1,
				ruleId: "as_any",
				message:
					"`as any` cast erases types — use a typed assertion, generic, or schema validator.",
				matchKey: "as_any:as any",
			},
		]);
	});

	// test-contract: invariant — multiset keys use the trimmed original source line, independent of surrounding formatting.
	it("trims source-line whitespace in a finding key", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/overlay.ts",
			"  const value = input as any;  \n",
			{ preContent: "" },
		);
		expect(result.newFindings[0]?.matchKey).toBe(
			"as_any:const value = input as any;",
		);
	});

	// test-contract: boundary — the as-any matcher accepts repeated separating whitespace but rejects a glued identifier.
	it("requires whitespace between as and any", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/overlay.ts",
			"const spaced = input as  any;\nconst glued = input asany;",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.matchKey).toBe(
			"as_any:const spaced = input as  any;",
		);
	});

	// test-contract: boundary — the unknown-as matcher accepts repeated separating whitespace while retaining both word boundaries.
	it("requires whitespace on both sides of unknown in an unknown-as chain", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/overlay.ts",
			"const spaced = input as  unknown as  Output;\nconst glued = input asunknown as Output;",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.matchKey).toBe(
			"as_unknown_chain:const spaced = input as  unknown as  Output;",
		);
	});

	// test-contract: invariant — bare annotations are recognized even when no whitespace follows the colon.
	it("recognizes a colon immediately followed by any", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/overlay.ts",
			"function handle(value:any) { return value; }",
			{ preContent: "" },
		);
		expect(result.newFindings[0]?.ruleId).toBe("bare_any_annotation");
	});

	// test-contract: public-api — a new-file evaluation without options reports findings as applicable.
	it("returns applicable findings when no pre-edit options are supplied", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/type-erasure-new-file.ts",
			"const value = input as any;",
		);
		expect(result.applicable).toBe(true);
		expect(result.newFindings).toHaveLength(1);
	});

	// test-contract: public-api — an explicitly provided empty pre-edit snapshot is honored instead of consulting disk.
	it("honors an explicit empty pre-edit snapshot", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/type-erasure-empty-pre.ts",
			"const value = input as any;",
			{ preContent: "" },
		);
		expect(result.applicable).toBe(true);
		expect(result.newFindings).toHaveLength(1);
	});

	// test-contract: boundary — an own preContent property with undefined means a new-file snapshot even when the path exists.
	it("treats an own undefined preContent as an explicit new-file snapshot", () => {
		const result = evaluateTypeErasureOverlay(
			"src/hook-entry-daemon-probe.test.ts",
			"} as unknown as UnifiedHookEvent;",
			{ preContent: undefined },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.ruleId).toBe("as_unknown_chain");
	});

	// test-contract: invariant — repeated identical findings are subtracted one-for-one rather than by a boolean presence check.
	it("subtracts repeated match keys as a multiset", () => {
		const pre = "const value = input as any;\n";
		const post = `${pre}${pre}`;
		const result = evaluateTypeErasureOverlay("/tmp/overlay.ts", post, {
			preContent: pre,
		});
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.line).toBe(2);
	});

	// test-contract: public-api — test-file paths relax only the bare annotation rule while retaining other type-erasure rules.
	it("recognizes test-file path boundaries precisely", () => {
		const cases = [
			// Suffix after ".test." defeats the end anchor; the path must still carry
			// a real TS extension or the overlay is not applicable at all.
			{ path: "/tmp/foo.test.ts.extra.ts", expected: true },
			{ path: "/tmp/test/foo.ts", expected: false },
			{ path: "/tmp/tests/foo.ts", expected: false },
		];
		for (const { path, expected } of cases) {
			const result = evaluateTypeErasureOverlay(path, "const value: any = {};", {
				preContent: "",
			});
			expect(result.newFindings.some((f) => f.ruleId === "bare_any_annotation")).toBe(
				expected,
			);
		}
	});

	// test-contract: invariant — each public rule keeps its documented diagnostic message.
	it("preserves messages for every public type-erasure rule", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/overlay.ts",
			[
				"const a = input as any;",
				"const b = input as unknown as Output;",
				"// @ts-ignore",
				"const c: any = input;",
			].join("\n"),
			{ preContent: "" },
		);
		const messages = new Map(result.newFindings.map((f) => [f.ruleId, f.message]));
		expect(messages.get("as_any")).toBe(
			"`as any` cast erases types — use a typed assertion, generic, or schema validator.",
		);
		expect(messages.get("as_unknown_chain")).toBe(
			"`as unknown as T` chain bypasses type checking — narrow with a type guard or runtime validator.",
		);
		expect(messages.get("unjustified_ts_directive")).toBe(
			"TypeScript suppression directive without an inline justification — write `// @ts-expect-error: <reason>` so the next reader knows why.",
		);
		expect(messages.get("bare_any_annotation")).toBe(
			"Bare `: any` annotation — name the actual shape (interface, generic, or branded type).",
		);
	});
});
