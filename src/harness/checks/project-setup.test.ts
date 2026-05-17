// Tests for project-setup.ts — focuses on the universal
// tsconfig.types ↔ deps cross-check helper.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkClaudeSettingsPermissions,
	checkProjectSetup,
	checkTsConfigTypesAgainstDeps,
} from "./project-setup.js";

describe("checkTsConfigTypesAgainstDeps", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "psetup-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function writePkg(deps: Record<string, string>, devDeps: Record<string, string> = {}) {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ name: "x", dependencies: deps, devDependencies: devDeps }),
		);
	}

	it("returns nothing when types[] is absent", () => {
		writePkg({});
		expect(checkTsConfigTypesAgainstDeps({}, tmp)).toEqual([]);
	});

	it("returns nothing when types[] is empty", () => {
		writePkg({});
		expect(checkTsConfigTypesAgainstDeps({ types: [] }, tmp)).toEqual([]);
	});

	it("flags scoped types[] entry that isn't in deps (the @cloudflare/workers-types CI failure)", () => {
		writePkg({}, {});
		const issues = checkTsConfigTypesAgainstDeps(
			{ types: ["@cloudflare/workers-types"] },
			tmp,
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toContain("@cloudflare/workers-types");
		expect(issues[0].fix).toContain("@cloudflare/workers-types");
	});

	it("passes when scoped types[] entry IS in deps", () => {
		writePkg({}, { "@cloudflare/workers-types": "^4.0.0" });
		expect(
			checkTsConfigTypesAgainstDeps({ types: ["@cloudflare/workers-types"] }, tmp),
		).toEqual([]);
	});

	it("passes when unscoped types[] entry exists as the package itself", () => {
		writePkg({}, { vitest: "^1.0.0" });
		expect(checkTsConfigTypesAgainstDeps({ types: ["vitest"] }, tmp)).toEqual([]);
	});

	it("passes when unscoped types[] entry exists as @types/<name>", () => {
		writePkg({}, { "@types/node": "^20.0.0" });
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toEqual([]);
	});

	it("flags unscoped types[] entry when neither variant is installed", () => {
		writePkg({}, {});
		const issues = checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toContain("node");
		expect(issues[0].message).toContain("@types/node");
		expect(issues[0].fix).toBe("Run `npm i --save-dev @types/node`");
	});

	it("checks peer- and optional-dependencies too", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				name: "x",
				peerDependencies: { "@types/node": "^20.0.0" },
			}),
		);
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toEqual([]);
	});

	it("emits one finding per missing entry", () => {
		writePkg({}, {});
		const issues = checkTsConfigTypesAgainstDeps(
			{ types: ["node", "vitest", "@cloudflare/workers-types"] },
			tmp,
		);
		expect(issues).toHaveLength(3);
	});

	it("ignores non-string entries silently", () => {
		writePkg({}, {});
		expect(checkTsConfigTypesAgainstDeps({ types: [42, null, ""] }, tmp)).toEqual([]);
	});

	it("returns no findings when package.json is unreadable", () => {
		// no package.json written — readAllDeps() returns {} on miss.
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toHaveLength(1);
	});
});

describe("checkProjectSetup", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "psetup-int-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns no issues when there are no TypeScript files", () => {
		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	it("integrates the types ↔ deps check end-to-end", () => {
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				strict: true,
				moduleResolution: "bundler",
				types: ["@cloudflare/workers-types"],
			},
		}));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("@cloudflare/workers-types"))).toBe(true);
	});

	it("surfaces malformed .claude/settings.json rules even in non-TS projects", () => {
		// No tsconfig.json, no .ts files — the TS-only checks short-circuit
		// but the Claude settings scan must still run.
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({
				permissions: {
					allow: ["Bash(ok *)", 'Bash(SESS_B="demo-$(date *)'],
				},
			}),
		);
		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.check === "permission_rule_syntax")).toBe(true);
		expect(issues.find((i) => i.check === "permission_rule_syntax")?.fix).toMatch(
			/interlinked doctor --fix/,
		);
	});

	it("does NOT recommend @types/node for node: imports that exist only in node_modules", () => {
		// Regression: the node:-protocol probe walked cwd recursively, including
		// node_modules, so a dependency's own `node:` imports made the check
		// fire on projects whose first-party code never touches a node builtin.
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
		writeFileSync(
			join(tmp, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true } }),
		);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		mkdirSync(join(tmp, "node_modules", "some-dep"), { recursive: true });
		writeFileSync(
			join(tmp, "node_modules", "some-dep", "index.ts"),
			'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
		);

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("@types/node"))).toBe(false);
	});

	it("still recommends @types/node when first-party source uses node: imports", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(
			join(tmp, "src", "app.ts"),
			'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
		);
		writeFileSync(
			join(tmp, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true } }),
		);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("@types/node"))).toBe(true);
	});

	it("does NOT label a pure-JavaScript project as TypeScript because node_modules ships .ts files", () => {
		// hasTypeScriptFiles must not be fooled by dependency .ts/.d.ts files.
		writeFileSync(join(tmp, "index.js"), "module.exports = 1;\n");
		mkdirSync(join(tmp, "node_modules", "some-dep"), { recursive: true });
		writeFileSync(
			join(tmp, "node_modules", "some-dep", "index.d.ts"),
			"export const x: number;\n",
		);

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => /tsconfig\.json/.test(i.message))).toBe(false);
	});
});

describe("checkClaudeSettingsPermissions", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "psetup-claude-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns no issues when no .claude/ directory exists", () => {
		expect(checkClaudeSettingsPermissions(tmp)).toEqual([]);
	});

	it("returns no issues when settings.json is clean", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({
				permissions: {
					allow: ["Bash(grep *)", "Bash(git *)", "WebFetch(domain:github.com)"],
				},
			}),
		);
		expect(checkClaudeSettingsPermissions(tmp)).toEqual([]);
	});

	it("flags each kind of malformed rule with its reason in the message", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({
				permissions: {
					allow: [
						"Bash(ok *)",
						'Bash(SESS_B="demo-$(date *)', // parens + quotes
						"",                              // empty
						"not-a-rule",                    // prefix
					],
				},
			}),
		);
		const issues = checkClaudeSettingsPermissions(tmp);
		expect(issues).toHaveLength(3);
		const reasons = issues.map((i) => i.message).join(" | ");
		expect(reasons).toMatch(/mismatched parentheses/);
		expect(reasons).toMatch(/empty rule/);
		expect(reasons).toMatch(/missing Tool\(\.\.\.\) prefix/);
	});

	it("scans both settings.json and settings.local.json", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(ok *)"] } }),
		);
		writeFileSync(
			join(tmp, ".claude", "settings.local.json"),
			// 2 opens, 1 close — depth = 1, mismatched parens (mirrors the
			// real-world `Bash(MARKER=$(date *)` shape that bit us on main).
			JSON.stringify({ permissions: { allow: ["Bash(SESS=$(date *)"] } }),
		);
		const issues = checkClaudeSettingsPermissions(tmp);
		expect(issues).toHaveLength(1);
		expect(issues[0].file).toMatch(/settings\.local\.json$/);
	});

	it("surfaces a parse error as a single issue instead of crashing", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(join(tmp, ".claude", "settings.json"), "{ not json");
		const issues = checkClaudeSettingsPermissions(tmp);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toMatch(/not valid JSON/);
	});
});
