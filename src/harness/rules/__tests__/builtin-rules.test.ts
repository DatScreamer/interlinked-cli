import { describe, expect, it } from "vitest";
import { BUILTIN_RULES } from "../builtin-rules.js";
import { DATABASE_AND_CLOUD_RULES } from "../builtin-rules-database.js";
import { DESTRUCTIVE_HTTP_RULES } from "../builtin-rules-destructive-http.js";
import { DESTRUCTIVE_V1_EXTRA_RULES } from "../builtin-rules-extras.js";
import { LANGUAGE_DESTRUCTIVE_RULES } from "../builtin-rules-language.js";
import { MCP_DESTRUCTIVE_RULES } from "../builtin-rules-mcp.js";
import { PROCESS_AND_FILESYSTEM_RULES } from "../builtin-rules-processes.js";
import { RAILWAY_RULES } from "../builtin-rules-railway.js";
import { RESOURCE_BOMB_RULES } from "../builtin-rules-resource-bombs.js";
import { SECURITY_AND_SAFETY_RULES } from "../builtin-rules-security.js";
import { SUPERMODEL_RULES } from "../builtin-rules-supermodel.js";

describe("builtin-rules", () => {
	it("aggregates all category rules", () => {
		const expectedCount =
			PROCESS_AND_FILESYSTEM_RULES.length +
			RESOURCE_BOMB_RULES.length +
			DATABASE_AND_CLOUD_RULES.length +
			RAILWAY_RULES.length +
			DESTRUCTIVE_V1_EXTRA_RULES.length +
			MCP_DESTRUCTIVE_RULES.length +
			DESTRUCTIVE_HTTP_RULES.length +
			LANGUAGE_DESTRUCTIVE_RULES.length +
			SECURITY_AND_SAFETY_RULES.length +
			SUPERMODEL_RULES.length;
		expect(BUILTIN_RULES.length).toBe(expectedCount);
	});

	it("has unique rule ids across all categories", () => {
		const ids = BUILTIN_RULES.map((r) => r.id);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});

	it("every rule has required fields", () => {
		for (const rule of BUILTIN_RULES) {
			expect(rule.id).toMatch(/^builtin-/);
			expect(rule.trigger).toBeDefined();
			expect(rule.action).toBeDefined();
			expect(rule.patterns.length).toBeGreaterThan(0);
			expect(rule.reason).toBeTruthy();
			expect(rule.category).toBeTruthy();
			expect(rule.severity).toBeTruthy();
		}
	});

	it("includes classic destructive rules", () => {
		const ids = BUILTIN_RULES.map((r) => r.id);
		expect(ids).toContain("builtin-rm-rf-root");
		expect(ids).toContain("builtin-git-force-push");
		expect(ids).toContain("builtin-git-reset-hard");
		expect(ids).toContain("builtin-drop-database");
		expect(ids).toContain("builtin-fork-bomb");
	});

	it("process-and-filesystem category covers process-killing and file-deletion", () => {
		const categories = new Set(PROCESS_AND_FILESYSTEM_RULES.map((r) => r.category));
		expect(categories).toContain("process-killing");
		expect(categories).toContain("file-deletion");
		expect(categories).toContain("git-operations");
	});

	it("database-and-cloud category covers database, containers, cloud-providers, wrangler", () => {
		const categories = new Set(DATABASE_AND_CLOUD_RULES.map((r) => r.category));
		expect(categories).toContain("database");
		expect(categories).toContain("containers");
		expect(categories).toContain("cloud-providers");
		expect(categories).toContain("wrangler");
	});

	it("language-destructive category covers language-specific and supply-chain", () => {
		const categories = new Set(LANGUAGE_DESTRUCTIVE_RULES.map((r) => r.category));
		expect(categories).toContain("language-destructive");
		expect(categories).toContain("supply-chain");
	});

	it("security-and-safety category covers supply-chain, process-safety, information-flow", () => {
		const categories = new Set(SECURITY_AND_SAFETY_RULES.map((r) => r.category));
		expect(categories).toContain("supply-chain");
		expect(categories).toContain("process-safety");
		expect(categories).toContain("information-flow");
	});

	it("destructive-http rule family is registered (PocketOS regression family)", () => {
		const ids = BUILTIN_RULES.map((r) => r.id);
		expect(ids).toContain("builtin-curl-rest-delete");
		expect(ids).toContain("builtin-graphql-destructive-mutation");
	});

	it("railway rule family is registered (PocketOS regression family)", () => {
		const ids = BUILTIN_RULES.map((r) => r.id);
		expect(ids).toContain("builtin-railway-cli-destructive");
		expect(ids).toContain("builtin-railway-graphql-destructive");
		expect(ids).toContain("builtin-railway-mcp-destructive");
	});

	it("mcp-destructive rule family is registered", () => {
		const ids = BUILTIN_RULES.map((r) => r.id);
		expect(ids).toContain("builtin-mcp-destructive-verb");
	});
});
