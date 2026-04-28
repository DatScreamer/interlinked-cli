// Railway-specific destructive-rule tests.
//
// Railway has unique architecture risks documented in PocketOS's 2026-04-25
// post-mortem:
//   - CLI tokens have blanket permissions (no operation/environment scoping)
//   - GraphQL API allows volumeDelete with zero confirmation
//   - Volume backups are stored IN the same volume — wiping a volume wipes
//     all backups simultaneously
//
// These rules are HARD BLOCKS (not ask) because:
//   1. Railway's authorization model has no scoped tokens; we cannot trust
//      that the agent's chosen token is environment-restricted.
//   2. The blast radius is total — the volume + all backups go together.
//   3. Recovery is uncertain (Railway gave PocketOS no SLA).
// User can override via .interlinked/guard-rules.local.json:disabled_rules
// if they're explicitly running a sandbox cleanup.

import { describe, expect, it } from "vitest";
import { RAILWAY_RULES } from "../builtin-rules-railway.js";

describe("RAILWAY_RULES — registry shape", () => {
	it("exports a non-empty array", () => {
		expect(Array.isArray(RAILWAY_RULES)).toBe(true);
		expect(RAILWAY_RULES.length).toBeGreaterThan(0);
	});
	it("uses action: block for the irrecoverable mutations", () => {
		// Volume / project / service / environment delete should be hard blocks.
		const blockedIds = RAILWAY_RULES.filter((r) => r.action === "block").map((r) => r.id);
		expect(blockedIds.length).toBeGreaterThan(0);
	});
	it("category is railway for every rule (so users can disable as a group)", () => {
		for (const r of RAILWAY_RULES) {
			expect(r.category).toBe("railway");
		}
	});
	it("severity is critical for every rule (Railway's blast radius is total)", () => {
		for (const r of RAILWAY_RULES) {
			expect(r.severity).toBe("critical");
		}
	});
});

function patternMatches(rules: typeof RAILWAY_RULES, command: string): boolean {
	for (const rule of rules) {
		for (const p of rule.patterns) {
			const re = new RegExp(p.regex, p.flags || "i");
			if (re.test(command)) return true;
		}
	}
	return false;
}

describe("Railway CLI delete commands", () => {
	it("matches railway volumes delete", () => {
		expect(patternMatches(RAILWAY_RULES, "railway volumes delete --volume-id abc")).toBe(true);
	});
	it("matches railway service delete", () => {
		expect(patternMatches(RAILWAY_RULES, "railway service delete my-service")).toBe(true);
	});
	it("matches railway environment delete", () => {
		expect(patternMatches(RAILWAY_RULES, "railway environment delete staging")).toBe(true);
	});
	it("matches railway project delete", () => {
		expect(patternMatches(RAILWAY_RULES, "railway project delete --confirm")).toBe(true);
	});
	it("matches railway down (the destroys-everything command)", () => {
		expect(patternMatches(RAILWAY_RULES, "railway down --yes")).toBe(true);
	});
	it("does NOT match railway up / deploy", () => {
		expect(patternMatches(RAILWAY_RULES, "railway up")).toBe(false);
		expect(patternMatches(RAILWAY_RULES, "railway deploy")).toBe(false);
	});
	it("does NOT match railway logs / status", () => {
		expect(patternMatches(RAILWAY_RULES, "railway logs --service my-app")).toBe(false);
		expect(patternMatches(RAILWAY_RULES, "railway status")).toBe(false);
	});
});

describe("Railway GraphQL mutations against backboard", () => {
	it("matches the literal volumeDelete mutation that took down PocketOS", () => {
		const cmd = [
			`curl -X POST https://backboard.railway.app/graphql/v2`,
			`-H "Authorization: Bearer abc"`,
			`-d '{"query":"mutation { volumeDelete(volumeId: \\"3d2c42fb-aaaa-bbbb-cccc-deadbeefdead\\") }"}'`,
		].join(" ");
		expect(patternMatches(RAILWAY_RULES, cmd)).toBe(true);
	});
	it("matches projectDelete mutation against backboard", () => {
		const cmd = `curl -d '{"query":"mutation { projectDelete(id: \\"p\\") }"}' https://backboard.railway.app/graphql/v2`;
		expect(patternMatches(RAILWAY_RULES, cmd)).toBe(true);
	});
	it("matches serviceDelete mutation", () => {
		const cmd = `curl -d '{"query":"mutation { serviceDelete(id: \\"s\\") }"}' https://backboard.railway.app/graphql/v2`;
		expect(patternMatches(RAILWAY_RULES, cmd)).toBe(true);
	});
	it("matches environmentDelete mutation", () => {
		const cmd = `curl -d '{"query":"mutation { environmentDelete(id: \\"e\\") }"}' https://backboard.railway.app/graphql/v2`;
		expect(patternMatches(RAILWAY_RULES, cmd)).toBe(true);
	});
	it("matches deploymentRemove mutation", () => {
		const cmd = `curl -d '{"query":"mutation { deploymentRemove(id: \\"d\\") }"}' https://backboard.railway.app/graphql/v2`;
		expect(patternMatches(RAILWAY_RULES, cmd)).toBe(true);
	});
	it("matches pluginDelete (Railway's add-on removal)", () => {
		const cmd = `curl -d '{"query":"mutation { pluginDelete(pluginId: \\"pg\\") }"}' https://backboard.railway.app/graphql/v2`;
		expect(patternMatches(RAILWAY_RULES, cmd)).toBe(true);
	});
	it("does NOT match non-Railway destructive curl (those are caught by the generic rule)", () => {
		const cmd = `curl -d '{"query":"mutation { volumeDelete(id: \\"x\\") }"}' https://api.fly.io/graphql`;
		expect(patternMatches(RAILWAY_RULES, cmd)).toBe(false);
	});
	it("does NOT match a Railway query (read-only)", () => {
		const cmd = `curl -d '{"query":"query { project(id: \\"p\\") { name } }"}' https://backboard.railway.app/graphql/v2`;
		expect(patternMatches(RAILWAY_RULES, cmd)).toBe(false);
	});
});

describe("Railway MCP tool destructive calls", () => {
	it("matches mcp__railway__volume_delete (MCP tool name pattern)", () => {
		// MCP tool calls match against the tool_name field, not the command.
		// We assert the rule has a tool_match that includes Railway MCP tools.
		const rule = RAILWAY_RULES.find((r) => r.id.includes("mcp"));
		expect(rule).toBeTruthy();
		if (!rule) return;
		// The rule should match a tool name beginning with mcp__railway__ and
		// containing a destructive verb.
		const matchesToolName = (toolName: string): boolean => {
			for (const p of rule.patterns) {
				if (p.field !== "tool_name") continue;
				const re = new RegExp(p.regex, p.flags || "i");
				if (re.test(toolName)) return true;
			}
			return false;
		};
		expect(matchesToolName("mcp__railway__volume_delete")).toBe(true);
		expect(matchesToolName("mcp__railway__service_remove")).toBe(true);
		expect(matchesToolName("mcp__railway__project_destroy")).toBe(true);
		// Must not match read-only Railway MCP tools.
		expect(matchesToolName("mcp__railway__list_projects")).toBe(false);
		expect(matchesToolName("mcp__railway__deploy")).toBe(false);
	});
});
