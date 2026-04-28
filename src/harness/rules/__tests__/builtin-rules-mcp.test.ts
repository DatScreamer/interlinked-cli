// Generic MCP destructive-tool guard.
//
// Premise: MCP tool names are deliberately verb-shaped — `volume_delete`,
// `project_destroy`, `database_drop`, `kv_purge`. We can use that
// convention as a defence-in-depth signal: if the agent is calling a tool
// whose name itself reads like a destructive operation, surface it for
// review even if we don't have a vendor-specific rule for it.
//
// Default action: ask. Reason: MCP tools span the entire vendor universe;
// hard-blocking by name pattern would be too aggressive. The user gets a
// per-call prompt on Claude/Cursor; on agents without ask, ask collapses
// to deny.
//
// This complements (does not replace) vendor-specific rules — those still
// hard-block where we know the operation is irrecoverable.

import { describe, expect, it } from "vitest";
import { MCP_DESTRUCTIVE_RULES } from "../builtin-rules-mcp.js";

describe("MCP_DESTRUCTIVE_RULES — registry shape", () => {
	it("exports a non-empty array", () => {
		expect(Array.isArray(MCP_DESTRUCTIVE_RULES)).toBe(true);
		expect(MCP_DESTRUCTIVE_RULES.length).toBeGreaterThan(0);
	});
	it("default action is ask", () => {
		for (const r of MCP_DESTRUCTIVE_RULES) {
			expect(r.action).toBe("ask");
		}
	});
	it("category is mcp-destructive for every rule", () => {
		for (const r of MCP_DESTRUCTIVE_RULES) {
			expect(r.category).toBe("mcp-destructive");
		}
	});
	it("uses tool_match: ['*'] (matches ALL tools, narrowed by pattern)", () => {
		for (const r of MCP_DESTRUCTIVE_RULES) {
			expect(r.tool_match).toContain("*");
		}
	});
});

function matchesToolName(rules: typeof MCP_DESTRUCTIVE_RULES, toolName: string): boolean {
	for (const rule of rules) {
		for (const p of rule.patterns) {
			if (p.field !== "tool_name") continue;
			const re = new RegExp(p.regex, p.flags || "i");
			if (re.test(toolName)) return true;
		}
	}
	return false;
}

describe("MCP destructive tool-name detection", () => {
	it("matches mcp__*__delete*", () => {
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__railway__volume_delete")).toBe(true);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__supabase__delete_table")).toBe(true);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__github__deleteRepo")).toBe(true);
	});
	it("matches mcp__*__destroy*", () => {
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__aws__destroy_stack")).toBe(true);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__terraform__destroy")).toBe(true);
	});
	it("matches mcp__*__drop*", () => {
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__postgres__drop_table")).toBe(true);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__db__dropDatabase")).toBe(true);
	});
	it("matches mcp__*__remove* / *__purge* / *__wipe* / *__terminate* / *__truncate*", () => {
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__redis__purge_all")).toBe(true);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__cache__wipe")).toBe(true);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__ec2__terminate_instance")).toBe(true);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__queue__remove_message")).toBe(true);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__db__truncate_table")).toBe(true);
	});
	it("matches snake_case and camelCase variants", () => {
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__x__delete_user")).toBe(true);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__x__deleteUser")).toBe(true);
	});

	it("does NOT match read-only tools", () => {
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__github__list_repos")).toBe(false);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__supabase__select_rows")).toBe(false);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__railway__deploy")).toBe(false);
	});
	it("does NOT match unrelated tool names that happen to share a substring", () => {
		// e.g., a `delivery` tool — must not match `delete`/`destroy`.
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__post__delivery_status")).toBe(false);
		// `purge` substring inside another word: `splurge` — must NOT match.
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "mcp__finance__splurgemeter")).toBe(false);
	});
	it("does NOT match non-MCP tools (those are caught by Bash rules)", () => {
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "Bash")).toBe(false);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "Read")).toBe(false);
		expect(matchesToolName(MCP_DESTRUCTIVE_RULES, "WebFetch")).toBe(false);
	});
});
