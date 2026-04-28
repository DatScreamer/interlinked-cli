// Tests for the generic destructive-HTTP rule family.
// These rules guard the class of failure that took down PocketOS on
// 2026-04-25: an agent issuing a destructive call to a vendor API directly
// via curl. The actual deletion was a Railway GraphQL mutation, but the
// shape generalises across vendors — we want curl-DELETE, GraphQL
// mutations carrying delete verbs, and Bash one-liner fetch() DELETEs all
// caught by this layer regardless of which vendor is on the other end.

import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_HTTP_RULES } from "../builtin-rules-destructive-http.js";

describe("DESTRUCTIVE_HTTP_RULES — registry shape", () => {
	it("exports a non-empty array of GuardRule entries", () => {
		expect(Array.isArray(DESTRUCTIVE_HTTP_RULES)).toBe(true);
		expect(DESTRUCTIVE_HTTP_RULES.length).toBeGreaterThan(0);
	});
	it("uses action: ask by default (so users on Claude/Cursor get a prompt; on others ask collapses to deny)", () => {
		// All rules in this family should be ask-actioned. If we ever add a
		// hard block here, change this assertion deliberately.
		for (const r of DESTRUCTIVE_HTTP_RULES) {
			expect(r.action).toBe("ask");
		}
	});
	it("every rule has an id beginning with builtin-", () => {
		for (const r of DESTRUCTIVE_HTTP_RULES) {
			expect(r.id.startsWith("builtin-")).toBe(true);
		}
	});
	it("every rule fires PreToolUse (gate must run before the call)", () => {
		for (const r of DESTRUCTIVE_HTTP_RULES) {
			expect(r.trigger).toBe("PreToolUse");
		}
	});
	it("severity is high or critical (no info/medium/low — these are unsafe operations)", () => {
		for (const r of DESTRUCTIVE_HTTP_RULES) {
			expect(["high", "critical"]).toContain(r.severity);
		}
	});
	it("category is destructive-http for all rules", () => {
		for (const r of DESTRUCTIVE_HTTP_RULES) {
			expect(r.category).toBe("destructive-http");
		}
	});
});

// Helper: run all rules' patterns against a candidate command string and
// return whether ANY pattern matches. This mirrors how the evaluator
// ultimately uses the rules (positive-OR over patterns within a rule).
function patternMatches(rules: typeof DESTRUCTIVE_HTTP_RULES, command: string, field = "command"): boolean {
	for (const rule of rules) {
		for (const p of rule.patterns) {
			if (p.field !== field) continue;
			const re = new RegExp(p.regex, p.flags || "i");
			if (re.test(command)) return true;
		}
	}
	return false;
}

describe("REST DELETE detection", () => {
	it("matches curl -X DELETE against an API", () => {
		expect(
			patternMatches(
				DESTRUCTIVE_HTTP_RULES,
				`curl -X DELETE https://api.example.com/v2/users/123 -H "Authorization: Bearer abc"`,
			),
		).toBe(true);
	});
	it("matches curl -XDELETE (no space)", () => {
		expect(
			patternMatches(DESTRUCTIVE_HTTP_RULES, "curl -XDELETE https://api.example.com/foo"),
		).toBe(true);
	});
	it("matches curl --request DELETE", () => {
		expect(
			patternMatches(
				DESTRUCTIVE_HTTP_RULES,
				`curl --request DELETE -H "Auth: x" https://example.com/r/1`,
			),
		).toBe(true);
	});
	it("matches xh DELETE form", () => {
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, "xh -X DELETE https://example.com/r/1")).toBe(
			true,
		);
	});
	it("does NOT match curl GET", () => {
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, "curl https://example.com/health")).toBe(false);
	});
	it("does NOT match curl POST without destructive verb", () => {
		expect(
			patternMatches(
				DESTRUCTIVE_HTTP_RULES,
				`curl -X POST -d '{"name":"foo"}' https://example.com/api/things`,
			),
		).toBe(false);
	});
});

describe("REST PUT/PATCH overwrite detection", () => {
	it("matches curl -X PUT with body", () => {
		expect(
			patternMatches(
				DESTRUCTIVE_HTTP_RULES,
				`curl -X PUT -d '{"a":"b"}' https://example.com/api/config`,
			),
		).toBe(true);
	});
	it("matches curl --request PATCH with body", () => {
		expect(
			patternMatches(
				DESTRUCTIVE_HTTP_RULES,
				`curl --request PATCH --data '{"a":"b"}' https://example.com/api/c`,
			),
		).toBe(true);
	});
	it("matches body-before-method order (curl -d ... -X PUT)", () => {
		// Regression: curl flags are order-independent. Previous regex required
		// `-X PUT` before `-d`, so this common shape bypassed the gate.
		expect(
			patternMatches(
				DESTRUCTIVE_HTTP_RULES,
				`curl -d '{"name":"x"}' -X PUT https://api.example.com/item/1`,
			),
		).toBe(true);
	});
	it("matches body-before-method order with --data and --request PATCH", () => {
		expect(
			patternMatches(
				DESTRUCTIVE_HTTP_RULES,
				`curl --data '{"a":"b"}' --request PATCH https://example.com/api/c`,
			),
		).toBe(true);
	});
	it("matches body-before-method with intermediate header flags", () => {
		expect(
			patternMatches(
				DESTRUCTIVE_HTTP_RULES,
				`curl -d '{"a":"b"}' -H "Authorization: Bearer x" -X PUT https://api.example.com/r/1`,
			),
		).toBe(true);
	});
	it("does NOT match curl PUT without a body (likely health check or noop)", () => {
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, "curl -X PUT https://example.com/health")).toBe(
			false,
		);
	});
});

describe("GraphQL mutation detection (the PocketOS shape)", () => {
	it("matches the literal Railway volumeDelete mutation that wiped PocketOS", () => {
		const cmd = [
			`curl -X POST https://backboard.railway.app/graphql/v2`,
			`-H "Authorization: Bearer some-token"`,
			`-d '{"query":"mutation { volumeDelete(volumeId: \\"3d2c42fb-aaaa-bbbb-cccc-deadbeefdead\\") }"}'`,
		].join(" ");
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("matches a generic deleteUser mutation", () => {
		const cmd = `curl -d '{"query":"mutation { deleteUser(id: \\"123\\") { id } }"}' https://api.example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("matches dropTable mutation", () => {
		const cmd = `curl -d '{"query":"mutation { dropTable(name: \\"orders\\") }"}' https://api.example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("matches purgeCache mutation (variant verb)", () => {
		const cmd = `curl -d '{"query":"mutation { purgeCache(scope: ALL) }"}' https://api.example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("matches terminateInstance mutation", () => {
		const cmd = `curl -d '{"query":"mutation { terminateInstance(id: \\"i-1\\") }"}' https://api.example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("does NOT match a plain query (no mutation keyword)", () => {
		const cmd = `curl -d '{"query":"query { user(id: \\"123\\") { name } }"}' https://example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(false);
	});
	it("does NOT match a mutation that creates rather than deletes", () => {
		const cmd = `curl -d '{"query":"mutation { createUser(name: \\"a\\") { id } }"}' https://example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(false);
	});
	it("matches mutation in --data-raw form (split across the line)", () => {
		const cmd = `curl --data-raw 'mutation { volumeDelete(volumeId: "abc") }' https://example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	// Regression: snake_case verbs were claimed to be covered by the
	// VERB_WORD_BOUNDARY pattern, but `\b` does NOT fire between `_` (a word
	// char) and a word char. Confirms the third pattern family (VERB_SNAKE_CASE)
	// catches these.
	it("matches snake_case volume_delete mutation", () => {
		const cmd = `curl -d '{"query":"mutation { volume_delete(id: \\"abc\\") }"}' https://example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("matches snake_case project_destroy mutation", () => {
		const cmd = `curl -d '{"query":"mutation { project_destroy(id: \\"p1\\") }"}' https://example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("matches snake_case instance_terminate mutation", () => {
		const cmd = `curl -d '{"query":"mutation { instance_terminate(id: \\"i-1\\") }"}' https://example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("matches SCREAMING_SNAKE all-caps verb (e.g. mutation { _DELETE_ALL })", () => {
		const cmd = `curl -d '{"query":"mutation { my_DELETE(id: \\"x\\") }"}' https://example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("matches snake_case verb via wget", () => {
		const cmd = `wget --post-data 'mutation { volume_delete(id: "abc") }' https://example.com/graphql`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
});

describe("Node/Bun/Deno fetch() destructive one-liners", () => {
	it("matches node -e fetch DELETE", () => {
		const cmd = `node -e 'fetch("https://api.example.com/r/1", { method: "DELETE", headers: { Authorization: "Bearer x" } })'`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("matches bun -e fetch DELETE with await", () => {
		const cmd = `bun -e 'await fetch("https://api.example.com/r/1", { method: "DELETE" })'`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(true);
	});
	it("does NOT match node -e fetch GET", () => {
		const cmd = `node -e 'fetch("https://api.example.com/health", { method: "GET" })'`;
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, cmd)).toBe(false);
	});
});

describe("WebFetch destructive URL detection", () => {
	it("matches WebFetch with /delete-all in path", () => {
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, "https://example.com/admin/delete-all", "url")).toBe(
			true,
		);
	});
	it("matches WebFetch with /destroy/ segment", () => {
		expect(patternMatches(DESTRUCTIVE_HTTP_RULES, "https://example.com/api/destroy/123", "url")).toBe(
			true,
		);
	});
	it("does NOT match a plain documentation URL", () => {
		expect(
			patternMatches(DESTRUCTIVE_HTTP_RULES, "https://docs.example.com/api/reference", "url"),
		).toBe(false);
	});
});
