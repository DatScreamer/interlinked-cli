import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectReadmeScriptDrift,
	resolveNearestPackageScripts,
} from "./readme-script-drift.js";

// ─── helpers ───────────────────────────────────────────────────────────────

const MD = "docs/setup.md";

/** getScripts mock: a repo whose package.json declares these scripts. */
function scriptsOf(...names: string[]): (p: string) => ReadonlySet<string> | null {
	const set: ReadonlySet<string> = new Set(names);
	return (_p: string) => set;
}

/** getScripts mock: no resolvable package.json (fail-open → no findings). */
function unresolvable(_p: string): ReadonlySet<string> | null {
	return null;
}

// ─── Positive cases — MUST fire ────────────────────────────────────────────

describe("detectReadmeScriptDrift — positive cases (must fire)", () => {
	it("flags `npm run <script>` in prose when the script is absent", () => {
		const md = "Run `npm run deploy` to ship the site.";
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build", "test"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"deploy"');
		// Pins the reported COMMAND text, not just the script name: a non-test
		// script must never be reported as "npm test".
		expect(results[0]?.text).toContain('"npm run deploy"');
	});

	it("flags `npm test` when no test script exists", () => {
		const md = "Then run `npm test` before pushing.";
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build", "lint"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"test"');
		// Pins the reported COMMAND text: a bare `npm test` reference must be
		// reported as "npm test", never rewritten to "npm run test".
		expect(results[0]?.text).toContain('"npm test"');
		expect(results[0]?.text).not.toContain('"npm run test"');
	});

	it("flags a missing script inside an ordinary code fence", () => {
		const md = ["Set up like so:", "", "```bash", "npm install", "npm run watch", "```"].join(
			"\n",
		);
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build", "test"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"watch"');
		expect(results[0]?.line).toBe(5);
	});

	it("flags typo'd scripts (the classic drift after a rename)", () => {
		const md = "Use `npm run typecheck:watch` during development.";
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("typecheck", "test"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"typecheck:watch"');
	});

	it("caps findings at 10 per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 15; i++) lines.push(`Run \`npm run missing${i}\` now.`);
		const results = detectReadmeScriptDrift(lines.join("\n"), MD, scriptsOf("build"));
		expect(results.length).toBeLessThanOrEqual(10);
	});
});

// ─── Negative cases — MUST NOT fire ────────────────────────────────────────

describe("detectReadmeScriptDrift — negative cases (must NOT fire)", () => {
	it("does not flag scripts that exist in package.json", () => {
		const md = [
			"Build with `npm run build`, verify with `npm test`.",
			"```bash",
			"npm run typecheck",
			"```",
		].join("\n");
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build", "test", "typecheck"));
		expect(results).toEqual([]);
	});

	it("returns no findings when no package.json is resolvable (fail-open)", () => {
		const md = "Run `npm run anything` here.";
		expect(detectReadmeScriptDrift(md, MD, unresolvable)).toEqual([]);
	});

	it("skips fences that clone / cd into another repo (foreign-repo setup)", () => {
		const md = [
			"To try the upstream demo:",
			"```bash",
			"git clone https://github.com/other/repo.git",
			"cd repo",
			"npm run demo",
			"```",
		].join("\n");
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});

	it("skips data fences (json/yaml) quoting commands as config strings", () => {
		const md = [
			"The rule emits this suggestion:",
			"```json",
			'{ "suggestion": "Use `npm run migrate:create` instead" }',
			"```",
		].join("\n");
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});

	it("does not fire on non-markdown files", () => {
		const code = 'console.log("npm run missing");';
		expect(detectReadmeScriptDrift(code, "src/index.ts", scriptsOf("build"))).toEqual([]);
	});

	it("does not treat flags after `npm run` as script names", () => {
		const md = "See `npm run --help` for details.";
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});

	it("does not flag the npm builtin `npm run env`", () => {
		const md = "Inspect the environment with `npm run env`.";
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});

	it("does not flag `npm test` when a test script exists", () => {
		const md = "CI runs `npm test` on every push.";
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("test"))).toEqual([]);
	});
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("detectReadmeScriptDrift — edge cases", () => {
	it("dedupes repeated references to the same missing script on one line", () => {
		const md = "`npm run gone` (yes, `npm run gone`).";
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
	});

	it("a cd inside one fence does not suppress findings in a later fence", () => {
		const md = [
			"```bash",
			"cd examples/demo",
			"npm run demo",
			"```",
			"Back in this repo:",
			"```bash",
			"npm run missing",
			"```",
		].join("\n");
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"missing"');
	});

	it("handles `npm run-script` alias", () => {
		const md = "Legacy docs say `npm run-script bundle`.";
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"bundle"');
	});
});

// ─── resolveNearestPackageScripts (fs-backed production resolver) ───────────

describe("resolveNearestPackageScripts", () => {
	const fixtures: string[] = [];

	function makeFixture(): string {
		const dir = mkdtempSync(join(tmpdir(), "readme-script-drift-"));
		fixtures.push(dir);
		return dir;
	}

	afterEach(() => {
		while (fixtures.length > 0) {
			const dir = fixtures.pop();
			if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("finds the nearest package.json walking up from the markdown file", () => {
		const root = makeFixture();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { alpha: "echo a", beta: "echo b" } }),
		);
		mkdirSync(join(root, "docs", "guides"), { recursive: true });
		const scripts = resolveNearestPackageScripts(join(root, "docs", "guides", "x.md"), root);
		expect(scripts).not.toBeNull();
		expect(scripts?.has("alpha")).toBe(true);
		expect(scripts?.has("beta")).toBe(true);
		expect(scripts?.has("gamma")).toBe(false);
	});

	it("returns null when no package.json exists within the stop directory", () => {
		const root = makeFixture();
		mkdirSync(join(root, "docs"), { recursive: true });
		expect(resolveNearestPackageScripts(join(root, "docs", "x.md"), root)).toBeNull();
	});

	it("returns null on malformed package.json (fail-open)", () => {
		const root = makeFixture();
		writeFileSync(join(root, "package.json"), "{ not json");
		expect(resolveNearestPackageScripts(join(root, "x.md"), root)).toBeNull();
	});

	it("prefers a nested package.json over the root one (monorepo shape)", () => {
		const root = makeFixture();
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { rootOnly: "x" } }));
		mkdirSync(join(root, "packages", "web", "docs"), { recursive: true });
		writeFileSync(
			join(root, "packages", "web", "package.json"),
			JSON.stringify({ scripts: { webOnly: "y" } }),
		);
		const scripts = resolveNearestPackageScripts(
			join(root, "packages", "web", "docs", "x.md"),
			root,
		);
		expect(scripts?.has("webOnly")).toBe(true);
		expect(scripts?.has("rootOnly")).toBe(false);
	});
});
