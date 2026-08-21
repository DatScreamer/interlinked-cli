import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateTypeErasureOverlay } from "./type-erasure-overlay.js";

const AS_ANY_MESSAGE =
	"`as any` cast erases types — use a typed assertion, generic, or schema validator.";
const AS_UNKNOWN_MESSAGE =
	"`as unknown as T` chain bypasses type checking — narrow with a type guard or runtime validator.";
const TS_DIRECTIVE_MESSAGE =
	"TypeScript suppression directive without an inline justification — write `// @ts-expect-error: <reason>` so the next reader knows why.";
const BARE_ANY_MESSAGE =
	"Bare `: any` annotation — name the actual shape (interface, generic, or branded type).";

describe("type-erasure overlay mutation kills (w25)", () => {
	// --- unjustified_ts_directive guard regex (site 164f632a7d0762b6) ---

	// test-contract: boundary — trailing text with no separator character is never a justification.
	it("treats a trailing token with no separator as unjustified", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/ts-directive-no-sep.ts",
			"// @ts-ignore reason for this\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.ruleId).toBe("unjustified_ts_directive");
	});

	// test-contract: boundary — a separator glued directly to the justification token (zero whitespace) is accepted.
	it("accepts a separator glued directly to a justification token", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/ts-directive-glued.ts",
			"// @ts-ignore:reason\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toEqual([]);
	});

	// test-contract: boundary — a separator followed by one whitespace character then a token is accepted.
	it("accepts a separator followed by a single space then a justification", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/ts-directive-onespace.ts",
			"// @ts-ignore: reason\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toEqual([]);
	});

	// test-contract: boundary — a separator followed only by whitespace (no token) is not a justification.
	it("treats separator-plus-whitespace-only trailing text as unjustified", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/ts-directive-whitespace-only.ts",
			"// @ts-ignore:   \n",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.ruleId).toBe("unjustified_ts_directive");
	});

	// --- bare_any_annotation type-alias exemption regex (site 086f548ce4b55b7b) ---

	// test-contract: invariant — a well-formed, unindented single-name type alias is exempt.
	it("exempts a minimal unindented type alias declaration", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/alias-minimal.ts",
			"type Foo = { x: any };\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toEqual([]);
	});

	// test-contract: boundary — the type-alias exemption never matches a `type X =` substring that is not the start of the line.
	it("does not exempt a bare annotation when a type-alias-shaped substring appears mid-line", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/alias-midline.ts",
			"const v: any = 1; type Foo = string;\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.ruleId).toBe("bare_any_annotation");
	});

	// test-contract: boundary — leading indentation before the alias keyword is honored.
	it("exempts an indented type alias declaration", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/alias-indented.ts",
			"  type Foo = { x: any };\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toEqual([]);
	});

	// test-contract: boundary — the optional `export` prefix tolerates more than one space before `type`.
	it("exempts an exported alias with extra spacing after export", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/alias-export-extra-space.ts",
			"export  type Foo = { x: any };\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toEqual([]);
	});

	// test-contract: boundary — the optional `export` prefix works with exactly one separating space.
	it("exempts an exported alias with a single separating space", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/alias-export-single-space.ts",
			"export type Foo = { x: any };\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toEqual([]);
	});

	// test-contract: boundary — extra spacing between `type` and the alias name is tolerated.
	it("exempts an alias with extra spacing after the type keyword", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/alias-type-extra-space.ts",
			"type  Foo = { x: any };\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toEqual([]);
	});

	// test-contract: boundary — zero spacing before the `=` sign is tolerated.
	it("exempts an alias with no space before the equals sign", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/alias-no-space-eq.ts",
			"type Foo= { x: any };\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toEqual([]);
	});

	// --- findAll internals (loop body) ---

	// test-contract: public-api — content with no type-erasure patterns produces no findings on a fresh path.
	it("produces no findings for content with no type-erasure patterns", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/te-overlay-clean-file.ts",
			"const x = 1;\n",
		);
		expect(result.newFindings).toEqual([]);
		expect(result.applicable).toBe(true);
	});

	// test-contract: invariant — column, rule id, and match key are computed exactly for an indented match.
	it("computes an exact column and trimmed match key for an indented match", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/te-overlay-indented.ts",
			"   as any   \n",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.column).toBe(4);
		expect(result.newFindings[0]?.matchKey).toBe("as_any:as any");
	});

	// --- evaluateTypeErasureOverlay control flow ---

	describe("with a temp file backing disk reads", () => {
		let dir: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "te-overlay-w25-"));
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		// test-contract: public-api — with no options at all, evaluation succeeds and reports the finding.
		it("evaluates cleanly with no options argument at all", () => {
			const filePath = join(dir, "no-options.ts");
			const result = evaluateTypeErasureOverlay(filePath, "const v = input as any;\n");
			expect(result).toEqual({
				newFindings: [
					{
						line: 1,
						column: 17,
						ruleId: "as_any",
						message: AS_ANY_MESSAGE,
						matchKey: "as_any:const v = input as any;",
					},
				],
				applicable: true,
			});
		});

		// test-contract: boundary — an explicit preContent equal to the post content reports zero new findings, ignoring disk.
		it("honors an explicit matching preContent without consulting disk", () => {
			const filePath = join(dir, "explicit-match.ts");
			const content = "const v = input as any;\n";
			const result = evaluateTypeErasureOverlay(filePath, content, {
				preContent: content,
			});
			expect(result.newFindings).toEqual([]);
			expect(result.applicable).toBe(true);
		});

		// test-contract: boundary — an explicit preContent takes precedence over differing on-disk content.
		it("prefers an explicit preContent over differing on-disk content", () => {
			const filePath = join(dir, "explicit-wins.ts");
			writeFileSync(filePath, "", "utf-8");
			const content = "const v = input as any;\n";
			const result = evaluateTypeErasureOverlay(filePath, content, {
				preContent: content,
			});
			expect(result.newFindings).toEqual([]);
			expect(result.applicable).toBe(true);
		});

		// test-contract: public-api — with no options and matching on-disk content, disk is consulted and the finding is subtracted.
		it("consults disk when no options are supplied and reports zero new findings for matching content", () => {
			const filePath = join(dir, "disk-match.ts");
			const content = "const v = input as any;\n";
			writeFileSync(filePath, content, "utf-8");
			const result = evaluateTypeErasureOverlay(filePath, content);
			expect(result.newFindings).toEqual([]);
			expect(result.applicable).toBe(true);
		});

		// test-contract: invariant — an own preContent property set to undefined means "new file", even when disk has matching content.
		it("treats an own undefined preContent as new-file even with matching disk content", () => {
			const filePath = join(dir, "own-undefined.ts");
			const content = "const v = input as any;\n";
			writeFileSync(filePath, content, "utf-8");
			const result = evaluateTypeErasureOverlay(filePath, content, {
				preContent: undefined,
			});
			expect(result.newFindings).toHaveLength(1);
			expect(result.applicable).toBe(true);
		});

		// test-contract: boundary — an empty options object (no preContent key) still consults disk like no options at all.
		it("consults disk for an empty options object without a preContent key", () => {
			const filePath = join(dir, "empty-options.ts");
			const content = "const v = input as any;\n";
			writeFileSync(filePath, content, "utf-8");
			const result = evaluateTypeErasureOverlay(filePath, content, {});
			expect(result.newFindings).toEqual([]);
			expect(result.applicable).toBe(true);
		});

		// test-contract: invariant — a repeated match key is subtracted one occurrence at a time, not eliminated wholesale.
		it("subtracts exactly one repeated occurrence per pre-existing credit", () => {
			const pre = "const value = input as any;\n";
			const post = pre + pre;
			const filePath = join(dir, "multiset.ts");
			const result = evaluateTypeErasureOverlay(filePath, post, { preContent: pre });
			expect(result.newFindings).toHaveLength(1);
			expect(result.newFindings[0]?.line).toBe(2);
			expect(result.applicable).toBe(true);
		});
	});

	// --- (module) top-level pattern definitions ---

	// test-contract: boundary — the eligible-extension regex requires the extension at the exact end of the path.
	it("rejects a path where the TS extension is not the final suffix", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/foo.ts.backup",
			"const value = input as any;",
			{ preContent: "" },
		);
		expect(result).toEqual({ newFindings: [], applicable: false });
	});

	// test-contract: boundary — the test-file regex's first alternative requires the test-suffix at the exact end of the path.
	it("does not treat a path with a mid-path test suffix as a test file", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/foo.test.other.ts",
			"const v: any = 1;\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.ruleId).toBe("bare_any_annotation");
	});

	// test-contract: boundary — the test-file regex's directory alternative accepts the singular "/test/" segment.
	it("treats a singular /test/ directory segment as a test file", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/test/foo.ts",
			"const v: any = 1;\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toEqual([]);
	});

	// test-contract: boundary — the as-any matcher accepts more than one whitespace character between `as` and `any`.
	it("matches as-any across multiple whitespace characters", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/as-any-double-space.ts",
			"const x = input as  any;\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.matchKey).toBe("as_any:const x = input as  any;");
	});

	// test-contract: invariant — the as-any finding carries its documented message text.
	it("reports the exact as-any message", () => {
		const result = evaluateTypeErasureOverlay("/tmp/as-any-message.ts", "as any\n", {
			preContent: "",
		});
		expect(result.newFindings[0]?.message).toBe(AS_ANY_MESSAGE);
	});

	// test-contract: boundary — the as-unknown-as matcher accepts multiple whitespace characters before "unknown".
	it("matches as-unknown-as across multiple whitespace before unknown", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/as-unknown-pre-space.ts",
			"const x = input as  unknown as Output;\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.matchKey).toBe(
			"as_unknown_chain:const x = input as  unknown as Output;",
		);
	});

	// test-contract: boundary — the as-unknown-as matcher accepts multiple whitespace characters after "unknown".
	it("matches as-unknown-as across multiple whitespace after unknown", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/as-unknown-post-space.ts",
			"const x = input as unknown  as Output;\n",
			{ preContent: "" },
		);
		expect(result.newFindings).toHaveLength(1);
		expect(result.newFindings[0]?.matchKey).toBe(
			"as_unknown_chain:const x = input as unknown  as Output;",
		);
	});

	// test-contract: invariant — the as-unknown-as finding carries its documented message text.
	it("reports the exact as-unknown-as message", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/as-unknown-message.ts",
			"const b = input as unknown as Output;\n",
			{ preContent: "" },
		);
		expect(result.newFindings[0]?.message).toBe(AS_UNKNOWN_MESSAGE);
	});

	// test-contract: invariant — the unjustified-ts-directive finding carries its documented message text.
	it("reports the exact unjustified-ts-directive message", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/ts-directive-message.ts",
			"// @ts-ignore\n",
			{ preContent: "" },
		);
		expect(result.newFindings[0]?.message).toBe(TS_DIRECTIVE_MESSAGE);
	});

	// test-contract: boundary — the bare-any-annotation matcher accepts a colon glued directly to "any" with no space.
	it("matches a bare any annotation with no space after the colon", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/bare-any-glued.ts",
			"function handle(value:any) { return value; }\n",
			{ preContent: "" },
		);
		expect(result.newFindings[0]?.ruleId).toBe("bare_any_annotation");
	});

	// test-contract: invariant — the bare-any-annotation finding carries its documented message text.
	it("reports the exact bare-any-annotation message", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/bare-any-message.ts",
			"const c: any = input;\n",
			{ preContent: "" },
		);
		expect(result.newFindings[0]?.message).toBe(BARE_ANY_MESSAGE);
	});
});
