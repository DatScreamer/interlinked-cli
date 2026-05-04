import { beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, SessionTrajectory } from "../types.js";
import { makeEvent, makeSession } from "./fixtures/evaluator.js";

describe("evaluatePreToolUse — content checks", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	beforeEach(() => {
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		// Relax TDD enforce-mode for this non-TDD suite (see evaluator.test.ts).
		if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	// ===========================================
	// A-series: PreToolUse Content Checks
	// ===========================================

	describe("A-series content checks", () => {
		it("A1: blocks merge conflict markers", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content:
						"const x = 1;\n<<<<<<< HEAD\nconst y = 2;\n=======\nconst y = 3;\n>>>>>>> branch\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Merge conflict");
		});

		it("A1: allows files without conflict markers", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content: "const x = 1;\nconst y = 2;\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("A2: blocks on eval() (pre_block registry phase)", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content: "const result = eval(userInput);",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe("eval_usage");
			expect(result.reason).toContain("eval_usage");
			expect(result.reason).toContain("Fix ALL instances");
		});

		it("A6: warns on mixed import/require", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content: 'import { foo } from "./foo";\nconst bar = require("./bar");',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("Mixed import/require"))).toBe(true);
		});

		it("A6: skips mixed import/require for .cjs files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.cjs",
					content: 'import { foo } from "./foo";\nconst bar = require("./bar");',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			const hasWarning = result.warnings?.some((w) => w.includes("Mixed import/require"));
			expect(hasWarning).toBeFalsy();
		});

		it("A8: warns on SQL injection patterns", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/query.ts",
					content: "db.exec(`SELECT * FROM users WHERE id = $" + "{userId}`);",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("SQL injection"))).toBe(true);
		});

		it("A9: warns on wildcard CORS", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/server.ts",
					content: 'res.setHeader("Access-Control-Allow-Origin", "*");',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("CORS"))).toBe(true);
		});

		it("A10: warns on regex DoS patterns", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/validator.ts",
					content: "const re = /(a+)+$/;",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("ReDoS"))).toBe(true);
		});

		it("A11: warns on JSDoc containing premature */ from glob patterns", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/types.ts",
					content: '/** Glob pattern (uses "dir/**", "**/*.ext") */\nglob: string;',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("prematurely closes"))).toBe(true);
		});

		it("A11: does not warn on normal JSDoc comments", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/types.ts",
					content: "/** This is a normal JSDoc comment */\nexport const x = 1;",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("prematurely closes"))).toBeFalsy();
		});
	});

	// ===========================================
	// Phase B.4 — diff-class skip end-to-end
	// ===========================================
	// A comment-only Edit (quoted-string body change under spans.ts) must
	// still surface error-severity detectors (eval_usage stays a hard block)
	// while warning-severity detectors are skipped. This verifies the
	// classifier is wired through evaluateWriteContentGuards →
	// buildAgentSafetyChecks correctly.

	describe("Phase B.4 diff-class skip", () => {
		it("preserves the pre_block error-severity gate on a quoted-string Edit", () => {
			// Same eval(input) on both sides, only the surrounding string
			// literal changes. The diff is comment_only under spans.ts but
			// eval_usage (severity=error, phase=pre_block) MUST still block.
			const event = makeEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "/tmp/diff-class-skip-eval.ts",
					old_string: "const a = 'foo'; const x = eval(input);",
					new_string: "const a = 'bar'; const x = eval(input);",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe("eval_usage");
		});

		it("does not block on a pure quoted-string change with no error-severity violations", () => {
			// Comment_only diff that does not touch any error-severity check.
			// The dispatch should allow the write — the entire pre_warn
			// warning bucket is skipped under the diff-class gate.
			const event = makeEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "/tmp/diff-class-skip-quoted.ts",
					old_string: "echo 'hello'",
					new_string: "echo 'world'",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	// ===========================================
	// Markdown-first web fetching
	// ===========================================

	describe("markdown-first web fetching", () => {
		it("warns on Playwright browser_navigate", () => {
			const event = makeEvent({
				tool_name: "mcp__playwright__browser_navigate",
				tool_input: { url: "https://example.com/docs" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
			expect(result.warnings?.some((w) => w.includes("Accept: text/markdown"))).toBe(true);
		});

		it("warns on Chrome DevTools navigate_page", () => {
			const event = makeEvent({
				tool_name: "mcp__chrome-devtools__navigate_page",
				tool_input: { url: "https://blog.cloudflare.com/some-post/" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
		});

		it("does not warn on browser navigate without URL", () => {
			const event = makeEvent({
				tool_name: "mcp__playwright__browser_navigate",
				tool_input: {},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on non-navigation browser tools", () => {
			const event = makeEvent({
				tool_name: "mcp__playwright__browser_click",
				tool_input: { selector: "#btn" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("warns on curl without Accept: text/markdown", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl -sS https://docs.example.com/api-reference" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
		});

		it("warns on wget without Accept: text/markdown", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "wget https://example.com/page.html" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
		});

		it("does not warn when Accept: text/markdown is present", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: 'curl -sS -H "Accept: text/markdown" https://example.com/page',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl to localhost", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl http://localhost:8787/api/status" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on POST requests", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: "curl -X POST https://api.example.com/data",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl with --data (API call)", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: 'curl --data \'{"key":"val"}\' https://api.example.com/endpoint',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl with -o (binary download)", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: "curl -o output.tar.gz https://releases.example.com/v1.0.tar.gz",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl with JSON content type", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command:
						'curl -H "Content-Type: application/json" https://api.example.com/graphql',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});
	});

	// ===========================================
	// Strict-typing pre-overlay (gated, default off)
	// ===========================================
	describe("strict-typing pre-overlay", () => {
		it("does not block when the flag is off (default)", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/strict-typing-default.ts",
					content: "const x = foo as any;\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			// May warn from other checks, but must NOT block on the strict-typing gate.
			if (result.decision === "block") {
				expect(result.rule_id).not.toBe("strict-typing-overlay");
			}
		});

		it("blocks new `as any` when the flag is enabled", () => {
			rules.quality_checks.strict_typing_block = {
				enabled: true,
				file_types: [".ts", ".tsx"],
				timeout_ms: 500,
				severity: "error",
			};
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/strict-typing-on.ts",
					content: "const x = foo as any;\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe("strict-typing-overlay");
			expect(result.reason).toContain("as_any");
		});

		it("blocks unjustified @ts-ignore when enabled, allows justified", () => {
			rules.quality_checks.strict_typing_block = {
				enabled: true,
				file_types: [".ts"],
				timeout_ms: 500,
				severity: "error",
			};
			const blocked = evaluatePreToolUse(
				makeEvent({
					tool_name: "Write",
					tool_input: {
						file_path: "/tmp/strict-typing-bad.ts",
						content: "// @ts-ignore\nconst x = foo();\n",
					},
				}),
				rules,
				session,
				reservations,
				cohort,
			);
			expect(blocked.decision).toBe("block");
			expect(blocked.rule_id).toBe("strict-typing-overlay");

			const allowed = evaluatePreToolUse(
				makeEvent({
					tool_name: "Write",
					tool_input: {
						file_path: "/tmp/strict-typing-ok.ts",
						content: "// @ts-ignore: third-party types are missing\nconst x = foo();\n",
					},
				}),
				rules,
				session,
				reservations,
				cohort,
			);
			if (allowed.decision === "block") {
				expect(allowed.rule_id).not.toBe("strict-typing-overlay");
			}
		});
	});
});
