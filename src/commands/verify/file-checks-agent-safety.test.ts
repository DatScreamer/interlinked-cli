// ===========================================
// file-checks agent-safety group unit tests
// ===========================================
// Direct tests for the extracted agent-safety helpers. The orchestrator
// `runPerFileChecks` is asserted to delegate to these helpers (same findings,
// same order) via an equivalence check.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { type FileCheckContext, runPerFileChecks } from "./file-checks.js";
import { runAgentSafetyChecks, runCrapCheck } from "./file-checks-agent-safety.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";

function ctx(content: string, file = "/tmp/sample.ts"): FileCheckContext {
	return { file, content, relPath: "sample.ts", cwd: "/tmp", r: emptyResults(), piiOpts: {} };
}

function orchestrate(content: string, file = "/tmp/sample.ts"): CodeQualityResults {
	const r = emptyResults();
	runPerFileChecks({
		file,
		content,
		cwd: "/tmp",
		r,
		moduleExportsCache: new Map(),
		allEnvRefs: new Map(),
		piiOpts: {},
	});
	return r;
}

describe("runAgentSafetyChecks", () => {
	it("flags a thrown string literal (throw_literal)", () => {
		const c = ctx('throw "boom";\n');
		runAgentSafetyChecks(c);
		expect(c.r.throwLiteral.length).toBeGreaterThan(0);
		expect(nonNull(c.r.throwLiteral[0]).check).toBe("throw_literal");
	});

	it("flags eval usage (eval_usage)", () => {
		const c = ctx('const out = eval(userInput);\n');
		runAgentSafetyChecks(c);
		expect(c.r.evalUsage.length).toBeGreaterThan(0);
		expect(nonNull(c.r.evalUsage[0]).check).toBe("eval_usage");
	});

	it("flags a silently-swallowed promise rejection (silent_promise_catch)", () => {
		const c = ctx('fetch("/api").catch(() => {});\n');
		runAgentSafetyChecks(c);
		expect(c.r.silentPromiseSwallow.length).toBeGreaterThan(0);
		expect(nonNull(c.r.silentPromiseSwallow[0]).check).toBe("silent_promise_catch");
	});

	it("produces the same throw_literal findings as the orchestrator (delegation)", () => {
		const src = 'throw "boom";\n';
		const c = ctx(src);
		runAgentSafetyChecks(c);
		expect(c.r.throwLiteral).toEqual(orchestrate(src).throwLiteral);
	});

	it("is a no-op on benign content", () => {
		const c = ctx('export const value = 1;\n');
		runAgentSafetyChecks(c);
		expect(c.r.throwLiteral).toHaveLength(0);
		expect(c.r.evalUsage).toHaveLength(0);
		expect(c.r.silentPromiseSwallow).toHaveLength(0);
	});
});

describe("runCrapCheck", () => {
	it("is fail-open (no findings) when no coverage-final.json is present", () => {
		// cwd points at a dir with no coverage/coverage-final.json — the check
		// must emit nothing rather than throw.
		const c = ctx('function f() { return 1; }\n');
		expect(() => runCrapCheck(c)).not.toThrow();
		expect(c.r.crap).toHaveLength(0);
	});
});

// readme_script_drift wiring — a real tmp repo with a package.json so the
// production `resolveNearestPackageScripts` resolver runs end-to-end.
describe("runAgentSafetyChecks — readme_script_drift fixture repo", () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** Tmp repo whose package.json declares exactly one script: `build`. */
	function makeRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "readme-drift-repo-"));
		tmpDirs.push(dir);
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "fixture", scripts: { build: "tsup" } }),
			"utf-8",
		);
		return dir;
	}

	function runOnReadme(repo: string, markdown: string): CodeQualityResults {
		const file = join(repo, "README.md");
		writeFileSync(file, markdown, "utf-8");
		const c: FileCheckContext = {
			file,
			content: markdown,
			relPath: "README.md",
			cwd: repo,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		return c.r;
	}

	it("fires on a README referencing an npm script missing from package.json", () => {
		const r = runOnReadme(makeRepo(), "Ship with `npm run deploy`.\n");
		expect(r.readmeScriptDrift.length).toBe(1);
		expect(nonNull(r.readmeScriptDrift[0]).check).toBe("readme_script_drift");
		expect(nonNull(r.readmeScriptDrift[0]).message).toContain('"deploy"');
	});

	it("does not fire when the referenced script exists", () => {
		const r = runOnReadme(makeRepo(), "Build with `npm run build`.\n");
		expect(r.readmeScriptDrift).toHaveLength(0);
	});

	it("does not fire on non-markdown files (detector self-filters)", () => {
		const repo = makeRepo();
		const c: FileCheckContext = {
			file: join(repo, "notes.ts"),
			content: '// Run `npm run deploy` first\n',
			relPath: "notes.ts",
			cwd: repo,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.readmeScriptDrift).toHaveLength(0);
	});
});

// spec_path_ref wiring (round-2 #25) — proves the 3-arg detector fires through
// the production battery with the real existsSync-backed resolver, not only in
// its direct unit tests.
describe("runAgentSafetyChecks — spec_path_ref fixture repo", () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function runOnDoc(markdown: string, seedExistingPath?: string): CodeQualityResults {
		const dir = mkdtempSync(join(tmpdir(), "spec-pathref-repo-"));
		tmpDirs.push(dir);
		if (seedExistingPath) writeFileSync(join(dir, seedExistingPath), "seed", "utf-8");
		const file = join(dir, "PLAN.md");
		writeFileSync(file, markdown, "utf-8");
		const c: FileCheckContext = {
			file,
			content: markdown,
			relPath: "PLAN.md",
			cwd: dir,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		return c.r;
	}

	it("fires on a present-tense claim that a missing path exists in-repo", () => {
		const r = runOnDoc("# Plan\nThe full `invariants.toml` exists in-repo today.\n");
		expect(r.specPathRef.length).toBe(1);
		expect(nonNull(r.specPathRef[0]).check).toBe("spec_path_ref");
		expect(nonNull(r.specPathRef[0]).message).toContain("invariants.toml");
	});

	it("stays quiet when the claimed path actually exists (resolver end-to-end)", () => {
		const r = runOnDoc(
			"# Plan\nThe full `invariants.toml` exists in-repo today.\n",
			"invariants.toml",
		);
		expect(r.specPathRef).toHaveLength(0);
	});
});
