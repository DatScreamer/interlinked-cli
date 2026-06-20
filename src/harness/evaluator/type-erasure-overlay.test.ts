import { describe, expect, it } from "vitest";
import {
	STRICT_TYPING_RULE_ID,
	evaluateTypeErasureOverlay,
} from "./type-erasure-overlay.js";
import { nonNull } from "../../lib/non-null.js";

describe("evaluateTypeErasureOverlay", () => {
	it("exposes a stable rule id for block messages", () => {
		expect(STRICT_TYPING_RULE_ID).toBe("strict-typing-overlay");
	});

	it("returns applicable=false for non-TS extensions", () => {
		const result = evaluateTypeErasureOverlay("/tmp/foo.js", "const x = a as any;");
		expect(result.applicable).toBe(false);
		expect(result.newFindings).toEqual([]);
	});

	it("treats every finding as new on a new-file Write (no preContent)", () => {
		const result = evaluateTypeErasureOverlay(
			"/tmp/new.ts",
			"const x = foo as any;\nconst y = bar as unknown as Y;\n",
			{ preContent: undefined },
		);
		expect(result.applicable).toBe(true);
		const ids = result.newFindings.map((f) => f.ruleId).sort();
		expect(ids).toContain("as_any");
		expect(ids).toContain("as_unknown_chain");
	});

	it("subtracts pre-existing matches via line-text multiset", () => {
		const pre = "const a = foo as any;\nconst b = 1;\n";
		const post = "const a = foo as any;\nconst b = 1;\nconst c = baz as any;\n";
		const result = evaluateTypeErasureOverlay("/tmp/edit.ts", post, { preContent: pre });
		expect(result.newFindings).toHaveLength(1);
		expect(nonNull(result.newFindings[0]).ruleId).toBe("as_any");
		expect(nonNull(result.newFindings[0]).line).toBe(3);
	});

	it("does not flag matches that exist in both pre and post unchanged", () => {
		const both = "const a = foo as any;\nconst b = bar as unknown as B;\n";
		const result = evaluateTypeErasureOverlay("/tmp/touch.ts", both, { preContent: both });
		expect(result.newFindings).toEqual([]);
	});

	it("flags @ts-ignore without justification", () => {
		const post = "// @ts-ignore\nconst x = unsafe();\n";
		const result = evaluateTypeErasureOverlay("/tmp/ignore.ts", post, { preContent: "" });
		expect(result.newFindings.some((f) => f.ruleId === "unjustified_ts_directive")).toBe(true);
	});

	it("allows @ts-ignore when an inline justification follows", () => {
		const post = "// @ts-ignore: third-party types are wrong here\nconst x = unsafe();\n";
		const result = evaluateTypeErasureOverlay("/tmp/ignore-ok.ts", post, { preContent: "" });
		expect(result.newFindings.some((f) => f.ruleId === "unjustified_ts_directive")).toBe(false);
	});

	it("ignores `: any` annotations in test files", () => {
		const post = "const mock: any = {};\n";
		const result = evaluateTypeErasureOverlay("/tmp/foo.test.ts", post, { preContent: "" });
		expect(result.newFindings.some((f) => f.ruleId === "bare_any_annotation")).toBe(false);
	});

	it("flags `: any` annotations in production files", () => {
		const post = "function handle(x: any) { return x; }\n";
		const result = evaluateTypeErasureOverlay("/tmp/prod.ts", post, { preContent: "" });
		expect(result.newFindings.some((f) => f.ruleId === "bare_any_annotation")).toBe(true);
	});

	it("ignores patterns inside string literals (offset-preserving strip)", () => {
		const post = 'const help = "use `as any` only when forced";\n';
		const result = evaluateTypeErasureOverlay("/tmp/str.ts", post, { preContent: "" });
		expect(result.newFindings).toEqual([]);
	});
});
