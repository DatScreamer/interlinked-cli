import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractEnvReferences, parseEnvDocumentation } from "../generic-checks.js";

describe("env documentation parsing", () => {
	let dir = "";

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("collects Wrangler vars and binding names from jsonc", () => {
		dir = mkdtempSync(join(tmpdir(), "env-docs-"));
		writeFileSync(
			join(dir, "wrangler.jsonc"),
			[
				"{",
				'  "durable_objects": {',
				'    "bindings": [{ "name": "MCP_OBJECT", "class_name": "AgentChatSQLite" }]',
				"  },",
				'  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "abc" }],',
				'  // "r2_buckets": [{ "binding": "ATTACHMENTS", "bucket_name": "attachments" }],',
				'  // "vars": { "TOOL_MODE": "extended" }',
				"}",
			].join("\n"),
		);

		const documented = parseEnvDocumentation(
			dir,
			{ existsSync, readFileSync, readdirSync },
			join,
		);

		expect(documented.has("MCP_OBJECT")).toBe(true);
		expect(documented.has("OAUTH_KV")).toBe(true);
		expect(documented.has("ATTACHMENTS")).toBe(true);
		expect(documented.has("TOOL_MODE")).toBe(true);
	});

	it("ignores standard shell env vars while keeping project-specific ones", () => {
		const refs = extractEnvReferences(
			[
				"process.env.NO_COLOR;",
				"process.env.USERNAME;",
				"process.env.USERPROFILE;",
				"process.env.INTERLINKED_TOKEN;",
			].join("\n"),
			"/tmp/example.ts",
		);

		expect(refs.map((ref) => ref.name)).toEqual(["INTERLINKED_TOKEN"]);
	});
});
