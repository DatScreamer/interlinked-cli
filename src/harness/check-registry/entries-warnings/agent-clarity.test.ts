import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_CLARITY_ENTRIES,
	checkCircularImportsAtCwd,
	checkDeadExportsAtCwd,
	checkUntestedIdempotentAtCwd,
	checkUntestedInversePairAtCwd,
} from "./agent-clarity.js";

describe("AGENT_CLARITY_ENTRIES", () => {
	it("is non-empty", () => {
		expect(AGENT_CLARITY_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of AGENT_CLARITY_ENTRIES) {
			expect(c.pipeline, c.id).toBe("agent_safety");
		}
	});

	it("every entry has a callable fn + valid phase + warning severity", () => {
		for (const c of AGENT_CLARITY_ENTRIES) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(["pre_warn", "post", "pre_block"], `${c.id} phase`).toContain(c.phase);
			expect(c.severity, `${c.id} severity`).toBe("warning");
		}
	});

	it("every entry has the required metadata fields populated", () => {
		for (const c of AGENT_CLARITY_ENTRIES) {
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.fix_instruction.length, `fix_instruction for ${c.id}`).toBeGreaterThan(20);
			expect(c.resultsPropName.length, `resultsPropName for ${c.id}`).toBeGreaterThan(0);
		}
	});

	it("includes the 2026-04 agent-quality cold-reader checks", () => {
		const ids = new Set(AGENT_CLARITY_ENTRIES.map((c) => c.id));
		for (const expected of [
			"default_export",
			"broad_object_types",
			"magic_literal_in_conditional",
			"unvalidated_json_boundary",
			"circular_imports",
			"lifecycle_cleanup",
			"dead_exports",
			"discriminated_union_exhaustiveness",
			"boolean_trap",
		]) {
			expect(ids, `should include ${expected}`).toContain(expected);
		}
	});

	it("includes the five comment-vs-behavior drift detectors", () => {
		const ids = new Set(AGENT_CLARITY_ENTRIES.map((c) => c.id));
		for (const expected of [
			"comment_claims_limit_no_guard",
			"comment_claims_null_throws_instead",
			"comment_claims_validation_missing",
			"comment_claims_idempotent_mutates",
			"comment_claims_throws_doesnt",
		]) {
			expect(ids, `should include ${expected}`).toContain(expected);
		}
	});

	it("has no duplicate ids", () => {
		const ids = AGENT_CLARITY_ENTRIES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

// ---------------------------------------------------------------------------
// checkCircularImportsAtCwd — registry-facing wrapper for `circular_imports`.
// Real DFS walk over files on disk, so a temp dir stands in for cwd.
// ---------------------------------------------------------------------------
describe("checkCircularImportsAtCwd", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-agent-clarity-cyc-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P1: flags a two-file import cycle (a → b → a)", () => {
		const aPath = join(dir, "a.ts");
		const aContent = 'import { b } from "./b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(join(dir, "b.ts"), 'import { a } from "./a.js";\nexport const b = () => a();\n');
		const out = checkCircularImportsAtCwd(aContent, aPath, dir);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.text).toContain("import cycle");
	});

	it("P2: flags a three-file import cycle (a → b → c → a)", () => {
		const aPath = join(dir, "a.ts");
		const aContent = 'import { b } from "./b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(join(dir, "b.ts"), 'import { c } from "./c.js";\nexport const b = () => c();\n');
		writeFileSync(join(dir, "c.ts"), 'import { a } from "./a.js";\nexport const c = () => a();\n');
		const out = checkCircularImportsAtCwd(aContent, aPath, dir);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("N1: does NOT flag an acyclic import chain", () => {
		const head = join(dir, "head.ts");
		const content = 'import { mid } from "./mid.js";\nexport const head = () => mid();\n';
		writeFileSync(head, content);
		writeFileSync(join(dir, "mid.ts"), "export const mid = () => 1;\n");
		expect(checkCircularImportsAtCwd(content, head, dir)).toEqual([]);
	});

	it("N2: does NOT flag a type-only import cycle (erased at compile time)", () => {
		const tPath = join(dir, "t.ts");
		const content = 'import type { U } from "./u.js";\nexport const t: U = {} as U;\n';
		writeFileSync(tPath, content);
		writeFileSync(join(dir, "u.ts"), 'import { t } from "./t.js";\nexport type U = typeof t;\n');
		expect(checkCircularImportsAtCwd(content, tPath, dir)).toEqual([]);
	});

	it("N3: skips a test file even when it would otherwise cycle", () => {
		const aPath = join(dir, "a.test.ts");
		const content = 'import { b } from "./b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, content);
		writeFileSync(join(dir, "b.ts"), 'import { a } from "./a.test.js";\nexport const b = () => a();\n');
		expect(checkCircularImportsAtCwd(content, aPath, dir)).toEqual([]);
	});

	it("defaults cwd to process.cwd() when the third argument is omitted (registry call shape)", () => {
		// The registry calls `fn(content, filePath)` with only two arguments —
		// this exercises that exact call shape against a path clearly outside
		// process.cwd(), so the default resolves to a real value and the
		// outside-root guard returns [] rather than throwing.
		expect(checkCircularImportsAtCwd("export const x = 1;\n", "/definitely/outside/root.ts")).toEqual(
			[],
		);
	});
});

// ---------------------------------------------------------------------------
// checkDeadExportsAtCwd — registry-facing wrapper for `dead_exports`. Project
// walk over real files (getGitSourceFiles shells to `git ls-files`).
// ---------------------------------------------------------------------------
describe("checkDeadExportsAtCwd", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-agent-clarity-dead-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P1: flags an export that no other file imports", () => {
		const libPath = join(dir, "lib.ts");
		const content = "export const used = 1;\nexport const orphan = 2;\n";
		writeFileSync(libPath, content);
		writeFileSync(join(dir, "consumer.ts"), 'import { used } from "./lib.js";\nconsole.log(used);\n');
		const out = checkDeadExportsAtCwd(content, libPath, dir);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("orphan");
	});

	it("N1: does NOT flag exports that are imported elsewhere", () => {
		const modPath = join(dir, "mod.ts");
		const content = "export const live = 7;\n";
		writeFileSync(modPath, content);
		writeFileSync(join(dir, "user.ts"), 'import { live } from "./mod.js";\nexport const v = live;\n');
		expect(checkDeadExportsAtCwd(content, modPath, dir)).toEqual([]);
	});

	it("N2: does NOT flag a barrel file (index.ts is skipped)", () => {
		const indexPath = join(dir, "index.ts");
		const content = "export const solo = 1;\n";
		writeFileSync(indexPath, content);
		expect(checkDeadExportsAtCwd(content, indexPath, dir)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// checkUntestedInversePairAtCwd — registry-facing wrapper for
// `untested_inverse_pair`. Uses a basename that appears in no real test-file
// path, so the path-prefilter finds zero candidates and the pair reads as
// untested → fires. process.cwd() is the real repo (safe: this check only
// reads the git-listed file set, it never writes).
// ---------------------------------------------------------------------------
describe("checkUntestedInversePairAtCwd", () => {
	const FAKE = "zzqp_agent_clarity_inverse_fixture";
	const fakePath = `${FAKE}.ts`;

	it("P1: bare encode/decode pair is flagged as untested", () => {
		const out = checkUntestedInversePairAtCwd(
			"export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }",
			fakePath,
			process.cwd(),
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("N1: fewer than two exports cannot form a pair, does not fire", () => {
		const out = checkUntestedInversePairAtCwd(
			"export function encode(x: string){ return x; }",
			fakePath,
			process.cwd(),
		);
		expect(out).toEqual([]);
	});

	it("N2: a .d.ts file is out of scope", () => {
		const out = checkUntestedInversePairAtCwd(
			"export function encode(){}\nexport function decode(){}",
			"x.d.ts",
			process.cwd(),
		);
		expect(out).toEqual([]);
	});

	it("defaults cwd to process.cwd() when the third argument is omitted (registry call shape)", () => {
		const out = checkUntestedInversePairAtCwd(
			"export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }",
			fakePath,
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// checkUntestedIdempotentAtCwd — registry-facing wrapper for
// `untested_idempotent`. Same fake-basename strategy as the inverse-pair
// suite above.
// ---------------------------------------------------------------------------
describe("checkUntestedIdempotentAtCwd", () => {
	const FAKE = "zzqp_agent_clarity_idempotent_fixture";
	const fakePath = `${FAKE}.ts`;

	it("P1: a bare normalize(x) export with an argument is flagged as untested", () => {
		const out = checkUntestedIdempotentAtCwd(
			"export function normalize(x: string){ return x.trim(); }",
			fakePath,
			process.cwd(),
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("N1: a non-idempotent-shaped export name does not fire", () => {
		const out = checkUntestedIdempotentAtCwd(
			"export function compute(x: string){ return x.trim(); }",
			fakePath,
			process.cwd(),
		);
		expect(out).toEqual([]);
	});

	it("N2: an idempotent-shaped name with NO arguments does not fire", () => {
		const out = checkUntestedIdempotentAtCwd(
			"export function normalize(){ return 1; }",
			fakePath,
			process.cwd(),
		);
		expect(out).toEqual([]);
	});

	it("defaults cwd to process.cwd() when the third argument is omitted (registry call shape)", () => {
		const out = checkUntestedIdempotentAtCwd(
			"export function normalize(x: string){ return x.trim(); }",
			fakePath,
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});
