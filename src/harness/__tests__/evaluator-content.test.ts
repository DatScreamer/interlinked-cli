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
		// Add built-in rules
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
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
});
