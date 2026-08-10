// Tests for the shared content-quality gate consumed by Edit/Write hooks,
// the `interlinked write` CLI subcommand, and MultiEdit.
//
// The gate runs:
//   1. pre_block registry checks (deterministic agent-safety rules)
//   2. biome diff-overlay
//   3. tsc diff-overlay (TypeScript LanguageService)
//   4. (optional) pre_warn registry checks
//
// These tests focus on the shape of the `gateProposedContent` entry point:
// a clean batch, a failing batch, and a mixed-pass/fail batch. The
// per-tool semantics (what biome/tsc flag, how diff-overlay filters
// pre-existing findings) are already covered by `diff-overlay.test.ts`
// and `tsc-overlay.test.ts`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DiffOverlayResult,
	evaluateBiomeDiffOverlay as EvaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay as EvaluateTscDiffOverlay,
} from "../diff-overlay.js";

// Marker substring: ONLY paths containing this get the synthetic ruleId-less
// finding from the diff-overlay mock below; every other path delegates to the
// real biome/tsc overlay so the rest of the suite exercises real toolchains.
const RULEID_FALLBACK_MARKER = "__gate_ruleid_fallback_probe__";

// Mock the diff-overlay module so we can drive the `f.ruleId ?? "biome"` /
// `f.ruleId ?? "tsc"` default-code fallbacks in content-gate. These fire only
// when a real biome/tsc finding has no ruleId — which the actual toolchains
// never emit (every diagnostic carries a code), so the only way to assert the
// gate's defaulting behavior is to inject a finding with `ruleId: undefined`.
// The factory delegates to the real implementation for all non-marker paths.
vi.mock("../diff-overlay.js", async () => {
	const actual = await vi.importActual<typeof import("../diff-overlay.js")>("../diff-overlay.js");
	const synthetic = (tool: "biome" | "tsc", file: string): DiffOverlayResult => ({
		newFindings: [
			{
				tool,
				severity: "error",
				file,
				line: 7,
				message: `synthetic ${tool} finding with no ruleId`,
				// ruleId deliberately omitted (exactOptionalPropertyTypes): drives
				// the `?? "${tool}"` default-code branch in the gate.
			},
		],
		elapsedMs: 1,
		exceededBudget: false,
	});
	const wrapBiome: typeof EvaluateBiomeDiffOverlay = (filePath, proposed, root) =>
		filePath.includes(RULEID_FALLBACK_MARKER)
			? synthetic("biome", filePath)
			: actual.evaluateBiomeDiffOverlay(filePath, proposed, root);
	const wrapTsc: typeof EvaluateTscDiffOverlay = (filePath, proposed, root) =>
		filePath.includes(RULEID_FALLBACK_MARKER)
			? synthetic("tsc", filePath)
			: actual.evaluateTscDiffOverlay(filePath, proposed, root);
	return { ...actual, evaluateBiomeDiffOverlay: wrapBiome, evaluateTscDiffOverlay: wrapTsc };
});

import { nonNull } from "../../lib/non-null.js";
import { sweepStaleFixtureDirs } from "./fixture-hygiene.js";
import {
	formatGateResult,
	GATE_SEVERITY_ERROR,
	GATE_SEVERITY_WARNING,
	gateProposedContent,
	readOnDiskOrUndefined,
} from "../content-gate.js";

// NB: for this file CLI_ROOT resolves to `src/harness` (two levels up from
// `src/harness/__tests__`), and that is exactly the `projectRoot` the gate is
// called with — biome/tsc config is found by walking UP from there to the repo
// root. (It is NOT the repo root; don't "fix" it.)
const CLI_ROOT = resolve(import.meta.dirname, "../..");
// Fixture files live in a UNIQUE per-process `mkdtempSync` dir, so no two test
// files (or parallel runs) ever write the same path — the parallel-safety
// invariant (the prior fixed `<CLI_ROOT>/lib/_content_gate_fixtures` path raced
// sibling overlay tests under `--file-parallelism`, flipping the gate's ok
// flag). The dir is rooted under CLI_ROOT (not os.tmpdir()) because the biome
// branch of the gate needs it there: the check-engine rewrites overlay findings
// to a projectRoot-relative path then filters to that file, so a fixture
// OUTSIDE projectRoot is silently dropped to zero findings. Under projectRoot,
// (a) tsc finds tsconfig.json by walking up and applies
// strict/exactOptionalPropertyTypes to the overlaid file, and (b) biome
// resolves biome.json from `cwd: projectRoot`. The `_…fixtures-` name is
// skipped by the strip-brace corpus walk. The fixtures are not `*.test.ts` and
// not in a `__tests__/` dir, so the registry detectors (pre_block / pre_warn)
// still run on them.
sweepStaleFixtureDirs(CLI_ROOT);
const FIXTURE_DIR = mkdtempSync(resolve(CLI_ROOT, "_content_gate_fixtures-"));
const CLEAN_FIXTURE = resolve(FIXTURE_DIR, "_gate_clean.ts");
const BIOME_FIXTURE = resolve(FIXTURE_DIR, "_gate_biome.ts");
const MIXED_FIXTURE_OK = resolve(FIXTURE_DIR, "_gate_mixed_ok.ts");
const MIXED_FIXTURE_BAD = resolve(FIXTURE_DIR, "_gate_mixed_bad.ts");
// Fixtures that exercise the registry phases (pre_block / pre_warn) and the
// tsc diff-overlay severity split. These are NOT *.test.ts and do NOT live in
// a __tests__/ dir, so the registry detectors (which skip strict test files)
// DO run against their content — that's the whole point.
const PRE_BLOCK_FIXTURE = resolve(FIXTURE_DIR, "_gate_preblock.ts");
const PRE_WARN_FIXTURE = resolve(FIXTURE_DIR, "_gate_prewarn.ts");
const TSC_FIXTURE = resolve(FIXTURE_DIR, "_gate_tsc.ts");
// Path carries the mock marker so the diff-overlay mock injects a ruleId-less
// finding. Must exist on disk so the gate enters its `if (existsSync(path))`
// overlay branches.
const RULEID_FALLBACK_FIXTURE = resolve(FIXTURE_DIR, `${RULEID_FALLBACK_MARKER}.ts`);

const CLEAN_CONTENT = `// clean gate fixture
export function identity<T>(x: T): T {
	return x;
}
`;

// Content that trips a deterministic pre_block registry check (eval_usage).
// We write this to disk AND propose it unchanged so the biome/tsc diff-overlays
// short-circuit to empty (proposed === on-disk) and ONLY the pre_block phase —
// which runs on the proposed content regardless of disk state — produces a
// failure. That isolates the pre_block branch from toolchain noise.
const PRE_BLOCK_CONTENT = `// pre_block gate fixture
export function run(src: string): unknown {
	return eval(src);
}
`;

// Content that trips a deterministic pre_warn registry check (floating_promises):
// a bare \`fetch(...)\` at statement position inside a function body, with no
// await / return / void / .catch(). fetch is in the builtin async-id allowlist.
const PRE_WARN_CONTENT = `// pre_warn gate fixture
export async function ping(): Promise<void> {
	fetch("https://example.test/health");
}
`;

// Fixture lifecycle. `beforeAll` primes biome once — cold `npx biome` is
// slow, so a throwaway run stabilises timing for the real assertions.
// `beforeEach` then re-materialises all four fixtures before every test:
// the dir is a private per-process tmp dir, so per-test rewrites keep every
// case hermetic (and resilient if a case mutates a fixture in place).
beforeAll(() => {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(CLEAN_FIXTURE, CLEAN_CONTENT);
	gateProposedContent([{ path: CLEAN_FIXTURE, content: CLEAN_CONTENT }], {
		projectRoot: CLI_ROOT,
	});
});
beforeEach(() => {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(CLEAN_FIXTURE, CLEAN_CONTENT);
	writeFileSync(BIOME_FIXTURE, CLEAN_CONTENT);
	writeFileSync(MIXED_FIXTURE_OK, CLEAN_CONTENT);
	writeFileSync(MIXED_FIXTURE_BAD, CLEAN_CONTENT);
	// Registry-phase fixtures: write the trigger content to disk so the
	// diff-overlay short-circuit (proposed === on-disk) keeps biome/tsc quiet.
	writeFileSync(PRE_BLOCK_FIXTURE, PRE_BLOCK_CONTENT);
	writeFileSync(PRE_WARN_FIXTURE, PRE_WARN_CONTENT);
	// tsc fixture starts clean on disk; proposed content introduces the error.
	writeFileSync(TSC_FIXTURE, CLEAN_CONTENT);
	// Marker fixture must exist so the gate calls the (mocked) diff-overlays.
	writeFileSync(RULEID_FALLBACK_FIXTURE, CLEAN_CONTENT);
});

afterAll(() => {
	// Remove the whole fixture subdir — cleaner than per-file rmSync and
	// leaves no stray state if the test is aborted mid-run.
	try {
		rmSync(FIXTURE_DIR, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});

describe("gateProposedContent", () => {
	it("clean batch: returns ok with no failures", () => {
		// Propose identical content — no new findings possible.
		const result = gateProposedContent([{ path: CLEAN_FIXTURE, content: CLEAN_CONTENT }], {
			projectRoot: CLI_ROOT,
		});
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
		expect(typeof result.elapsedMs).toBe("number");
	});

	// Retry on rare flake: under parallel load biome can exceed the per-file
	// overlay budget on cold start. Warm-up in beforeAll covers most cases;
	// retry covers the occasional tail.
	it("biome failure: double-equals trips noSelfCompare/noDoubleEquals", { retry: 2 }, () => {
		// Add a snippet that biome will flag as a new finding.
		const bad = `${CLEAN_CONTENT}\nexport function _probe() {\n\treturn 1 == 1;\n}\n`;
		const result = gateProposedContent([{ path: BIOME_FIXTURE, content: bad }], {
			projectRoot: CLI_ROOT,
		});
		expect(result.ok).toBe(false);
		const biomeFails = result.failures.filter((f) => f.tool === "biome");
		expect(biomeFails.length).toBeGreaterThan(0);
		expect(nonNull(biomeFails[0]).severity).toBe(GATE_SEVERITY_ERROR);
		const codes = biomeFails.map((f) => f.code).join(",");
		expect(codes).toMatch(/noSelfCompare|noDoubleEquals/);
	});

	it("mixed batch: one clean + one failing → batch fails, clean file surfaces no failures", { retry: 2 }, () => {
		const bad = `${CLEAN_CONTENT}\nexport function _probe() {\n\treturn 1 == 1;\n}\n`;
		const result = gateProposedContent(
			[
				{ path: MIXED_FIXTURE_OK, content: CLEAN_CONTENT }, // clean
				{ path: MIXED_FIXTURE_BAD, content: bad }, // failing
			],
			{ projectRoot: CLI_ROOT },
		);
		expect(result.ok).toBe(false);
		// Failures are all attributed to the bad fixture, not the clean one.
		const pathsWithFailures = new Set(result.failures.map((f) => f.path));
		expect(pathsWithFailures.has(MIXED_FIXTURE_BAD)).toBe(true);
		expect(pathsWithFailures.has(MIXED_FIXTURE_OK)).toBe(false);
	});

	it("new-file write (no disk snapshot): skips biome/tsc diff, pre_block still runs", () => {
		// A path that doesn't exist on disk. New-file writes can't be diffed,
		// so biome/tsc should produce 0 findings, but the result should still
		// be ok because no pre_block violation fires on this content.
		const nonExistent = resolve(FIXTURE_DIR, "_gate_does_not_exist.ts");
		const result = gateProposedContent([{ path: nonExistent, content: CLEAN_CONTENT }], {
			projectRoot: CLI_ROOT,
		});
		expect(result.ok).toBe(true);
		expect(result.failures.filter((f) => f.tool === "biome")).toEqual([]);
		expect(result.failures.filter((f) => f.tool === "tsc")).toEqual([]);
	});

	it("empty batch: trivially ok", () => {
		const result = gateProposedContent([], { projectRoot: CLI_ROOT });
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it("pre_block failure: an INTRODUCED eval() trips the registry as an error", () => {
		// Disk carries one eval; the proposal adds a SECOND, distinct one. Only
		// the introduced line is a transaction-killer (introduced-only
		// semantics, pre-block-gate.ts); the pre-existing one rides along as a
		// warning. The introduced line is line 5 of the proposal.
		const proposed = `${PRE_BLOCK_CONTENT}const risky = eval(process.argv[2] ?? "");\n`;
		const result = gateProposedContent([{ path: PRE_BLOCK_FIXTURE, content: proposed }], {
			projectRoot: CLI_ROOT,
		});
		expect(result.ok).toBe(false);
		const preBlock = result.failures.filter((f) => f.tool === "pre_block");
		const evalFail = preBlock.find((f) => f.code === "eval_usage" && f.severity === "error");
		expect(evalFail).toBeDefined();
		const nonNull = evalFail as NonNullable<typeof evalFail>;
		// The error names ONLY the introduced line, not the pre-existing L3.
		expect(nonNull.line).toBe(5);
		expect(nonNull.message).toMatch(/introduces 1 violation\(s\) at L5/);
		// hint = registry fix_instruction + the suppression escape.
		expect(typeof nonNull.hint).toBe("string");
		expect(nonNull.hint as string).toContain("interlinked-ignore: eval_usage");
		// The pre-existing on-disk instance surfaces as a non-blocking warning.
		const preexisting = preBlock.find((f) => f.severity === GATE_SEVERITY_WARNING);
		expect(preexisting?.message).toMatch(/pre-existing violation\(s\) at L3/);
	});

	it("pre_block pre-existing-only: rewriting the file unchanged WARNS but does not block", () => {
		// Disk content === proposed content: the eval() is pre-existing, so the
		// introduced-only gate must not brick the file (the bio-orchestrator
		// wall — one legacy finding blocking every unrelated future edit).
		const result = gateProposedContent(
			[{ path: PRE_BLOCK_FIXTURE, content: PRE_BLOCK_CONTENT }],
			{ projectRoot: CLI_ROOT },
		);
		expect(result.ok).toBe(true);
		const preBlock = result.failures.filter((f) => f.tool === "pre_block");
		expect(preBlock).toHaveLength(1);
		expect(preBlock[0]?.severity).toBe(GATE_SEVERITY_WARNING);
		expect(preBlock[0]?.message).toContain("pre-existing");
	});

	it("pre_block suppression: an inline interlinked-ignore directive exempts an introduced line", () => {
		const proposed =
			`${PRE_BLOCK_CONTENT}// interlinked-ignore: eval_usage — sandboxed REPL, input is vetted\n` +
			`const vetted = eval(process.argv[3] ?? "");\n`;
		const result = gateProposedContent([{ path: PRE_BLOCK_FIXTURE, content: proposed }], {
			projectRoot: CLI_ROOT,
		});
		// The introduced eval is suppressed; the pre-existing one still warns.
		expect(result.failures.filter((f) => f.tool === "pre_block" && f.severity === "error")).toEqual(
			[],
		);
		expect(result.ok).toBe(true);
	});

	it("projectRoot omitted: falls back to findProjectRoot/cwd and still gates", () => {
		// No projectRoot option → the gate computes it per-entry. The fixture
		// lives under the CLI tree, so findProjectRoot resolves a real root; an
		// INTRODUCED eval() still blocks. Exercises the
		// `opts.projectRoot ?? findProjectRoot(...) ?? cwd` fallback chain.
		const result = gateProposedContent([
			{ path: PRE_BLOCK_FIXTURE, content: `${PRE_BLOCK_CONTENT}const x = eval(input);\n` },
		]);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.tool === "pre_block" && f.code === "eval_usage")).toBe(
			true,
		);
	});

	it("projectRoot omitted + path outside the project: falls all the way through to cwd", () => {
		// A path OUTSIDE the harness cwd makes findProjectRoot() return null
		// (it clamps every result to within cwd), so the gate reaches the final
		// `?? process.cwd()` leg. The path doesn't exist on disk, so biome/tsc
		// diff-overlays are skipped; pre_block still runs on the eval() content.
		const outsidePath = resolve(tmpdir(), "_interlinked_gate_outside_probe.ts");
		const result = gateProposedContent([{ path: outsidePath, content: PRE_BLOCK_CONTENT }]);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.tool === "pre_block" && f.code === "eval_usage")).toBe(
			true,
		);
		// No diff-overlay findings: the file doesn't exist on disk.
		expect(result.failures.filter((f) => f.tool === "biome")).toEqual([]);
		expect(result.failures.filter((f) => f.tool === "tsc")).toEqual([]);
	});

	it("tsc diff-overlay: a new blocking type error (TS2322) surfaces as an error", () => {
		// On-disk is clean; proposed introduces a string→number assignment.
		const proposed = `${CLEAN_CONTENT}\nconst _bad: number = "not a number";\n`;
		const result = gateProposedContent([{ path: TSC_FIXTURE, content: proposed }], {
			projectRoot: CLI_ROOT,
		});
		expect(result.ok).toBe(false);
		const tscFails = result.failures.filter((f) => f.tool === "tsc");
		expect(tscFails.length).toBeGreaterThan(0);
		const ts2322 = tscFails.find((f) => f.code === "TS2322");
		expect(ts2322).toBeDefined();
		const nonNull = ts2322 as NonNullable<typeof ts2322>;
		expect(nonNull.severity).toBe(GATE_SEVERITY_ERROR);
		expect(nonNull.line).toBeGreaterThan(0);
		expect(nonNull.message.length).toBeGreaterThan(0);
	});

	it("tsc diff-overlay: a new warn-only type error (possibly-undefined) is a warning, not a blocker", () => {
		// strictNullChecks (strict:true) makes dereferencing a `T | undefined`
		// parameter a TS18048/TS2532-class diagnostic, which the gate demotes to
		// a warning. With ONLY that finding, the batch stays ok=true.
		const proposed = `${CLEAN_CONTENT}\nexport function deref(x: string | undefined): number {\n\treturn x.length;\n}\n`;
		const result = gateProposedContent([{ path: TSC_FIXTURE, content: proposed }], {
			projectRoot: CLI_ROOT,
		});
		const tscFails = result.failures.filter((f) => f.tool === "tsc");
		expect(tscFails.length).toBeGreaterThan(0);
		// Every tsc finding from this edit is the demote-to-warning kind.
		expect(tscFails.every((f) => f.severity === GATE_SEVERITY_WARNING)).toBe(true);
		// A warning-only batch is still "ok" (no blocking failures).
		const onlyTscFindings = result.failures.every((f) => f.tool === "tsc");
		if (onlyTscFindings) {
			expect(result.ok).toBe(true);
		}
		// The demoted code is one of the recognized possibly-null/undefined codes.
		const codes = tscFails.map((f) => f.code);
		expect(codes.some((c) => /^TS(2531|2532|18047|18048)$/.test(c))).toBe(true);
	});

	it("pre_warn skipped by default: floating-promise content produces no pre_warn failure", () => {
		// Default skipPreWarn=true → the pre_warn phase is not run even when the
		// content would trip floating_promises. Disk === proposed keeps biome/tsc
		// quiet, so the batch is clean.
		const result = gateProposedContent(
			[{ path: PRE_WARN_FIXTURE, content: PRE_WARN_CONTENT }],
			{ projectRoot: CLI_ROOT },
		);
		expect(result.failures.filter((f) => f.tool === "pre_warn")).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it("pre_warn enabled: floating-promise content surfaces a pre_warn warning (non-blocking)", () => {
		const result = gateProposedContent(
			[{ path: PRE_WARN_FIXTURE, content: PRE_WARN_CONTENT }],
			{ projectRoot: CLI_ROOT, skipPreWarn: false },
		);
		const preWarn = result.failures.filter((f) => f.tool === "pre_warn");
		expect(preWarn.length).toBeGreaterThan(0);
		const floating = preWarn.find((f) => f.code === "floating_promises");
		expect(floating).toBeDefined();
		const nonNull = floating as NonNullable<typeof floating>;
		expect(nonNull.severity).toBe(GATE_SEVERITY_WARNING);
		// 3rd line carries the bare fetch() call.
		expect(nonNull.line).toBe(3);
		expect(nonNull.message).toMatch(/violation\(s\) at L3/);
		expect(typeof nonNull.hint).toBe("string");
		// pre_warn is informational: a warning-only batch is still ok.
		const onlyWarnings = result.failures.every((f) => f.severity === GATE_SEVERITY_WARNING);
		if (onlyWarnings) {
			expect(result.ok).toBe(true);
		}
	});

	it("pre_warn enabled on clean content: pre_warn phase runs but finds nothing", () => {
		// skipPreWarn=false on content with NO pre_warn triggers exercises the
		// pre_warn loop's empty-matches continue path without producing failures.
		const result = gateProposedContent([{ path: CLEAN_FIXTURE, content: CLEAN_CONTENT }], {
			projectRoot: CLI_ROOT,
			skipPreWarn: false,
		});
		expect(result.ok).toBe(true);
		expect(result.failures.filter((f) => f.tool === "pre_warn")).toEqual([]);
	});

	it("ruleId-less overlay findings default to the tool name as the code", () => {
		// The diff-overlay mock injects biome+tsc findings with no ruleId for the
		// marker path. The gate must substitute the tool name via `?? "biome"` /
		// `?? "tsc"`. (Real biome/tsc always emit a code; this is the defensive
		// default path.)
		const proposed = `${CLEAN_CONTENT}\nexport const marker = 1;\n`;
		const result = gateProposedContent(
			[{ path: RULEID_FALLBACK_FIXTURE, content: proposed }],
			{ projectRoot: CLI_ROOT },
		);
		const biomeFail = result.failures.find((f) => f.tool === "biome");
		const tscFail = result.failures.find((f) => f.tool === "tsc");
		expect(biomeFail).toBeDefined();
		expect(tscFail).toBeDefined();
		// Default code === tool name when the finding carries no ruleId.
		expect((biomeFail as NonNullable<typeof biomeFail>).code).toBe("biome");
		expect((tscFail as NonNullable<typeof tscFail>).code).toBe("tsc");
		// The synthetic findings carry their line/column/message through verbatim.
		expect((biomeFail as NonNullable<typeof biomeFail>).line).toBe(7);
		// A ruleId-less tsc finding is treated as blocking (not warn-only), so the
		// batch fails.
		expect((tscFail as NonNullable<typeof tscFail>).severity).toBe(GATE_SEVERITY_ERROR);
		expect(result.ok).toBe(false);
	});
});

describe("formatGateResult", () => {
	it("renders 'clean' for an ok result with no failures", () => {
		const out = formatGateResult({ ok: true, failures: [], elapsedMs: 1 });
		expect(out).toMatch(/clean/);
	});

	it("renders per-file sections with tool + rule code + line", () => {
		const out = formatGateResult({
			ok: false,
			elapsedMs: 12,
			failures: [
				{
					path: "src/foo.ts",
					tool: "tsc",
					code: "TS2304",
					line: 14,
					message: "Cannot find name 'TOKEN'",
					severity: GATE_SEVERITY_ERROR,
				},
				{
					path: "src/foo.ts",
					tool: "biome",
					code: "noUnusedImports",
					line: 4,
					message: "helper is declared but never used",
					severity: GATE_SEVERITY_WARNING,
				},
			],
		});
		expect(out).toContain("src/foo.ts");
		expect(out).toContain("TS2304");
		expect(out).toContain("noUnusedImports");
		expect(out).toContain("tsc:");
		expect(out).toContain("biome:");
		// Warning prefix for non-blocking severity.
		expect(out).toContain("warn:");
		// Blocking failure carries NO warn: prefix on its own line.
		const tscLine = out.split("\n").find((l) => l.includes("TS2304")) ?? "";
		expect(tscLine).not.toContain("warn:");
		// Header reports the blocking/warning split and file count.
		expect(out).toMatch(/1 blocking failure\(s\), 1 warning\(s\) across 1 file\(s\)/);
		// Per-file location rendering for a known line.
		expect(out).toContain("line 14");
	});

	it("renders 'global' for a failure with no line (line 0)", () => {
		// A pre_block failure whose first match has line 0 (unknown location)
		// renders as "global" rather than "line N".
		const out = formatGateResult({
			ok: false,
			elapsedMs: 5,
			failures: [
				{
					path: "src/bar.ts",
					tool: "pre_block",
					code: "eval_usage",
					line: 0,
					message: "1 violation(s)",
					severity: GATE_SEVERITY_ERROR,
				},
			],
		});
		expect(out).toContain("global");
		expect(out).not.toContain("line 0");
		expect(out).toContain("pre_block:");
		expect(out).toContain("eval_usage");
	});

	it("groups multiple failures across distinct files into separate sections", () => {
		const out = formatGateResult({
			ok: false,
			elapsedMs: 7,
			failures: [
				{
					path: "src/a.ts",
					tool: "tsc",
					code: "TS2322",
					line: 1,
					message: "bad",
					severity: GATE_SEVERITY_ERROR,
				},
				{
					path: "src/b.ts",
					tool: "biome",
					code: "noDoubleEquals",
					line: 2,
					message: "use ===",
					severity: GATE_SEVERITY_ERROR,
				},
			],
		});
		expect(out).toContain("src/a.ts");
		expect(out).toContain("src/b.ts");
		expect(out).toMatch(/2 blocking failure\(s\), 0 warning\(s\) across 2 file\(s\)/);
	});

	it("renders 'clean' when result has no failures even if ok flag is false-y guarded", () => {
		// ok=true && failures empty → the early clean branch (distinct from the
		// failure-rendering branch). Includes the elapsedMs in the message.
		const out = formatGateResult({ ok: true, failures: [], elapsedMs: 42 });
		expect(out).toContain("clean");
		expect(out).toContain("42ms");
	});
});

describe("readOnDiskOrUndefined", () => {
	it("returns undefined for a missing path", () => {
		expect(readOnDiskOrUndefined(resolve(FIXTURE_DIR, "_missing.ts"))).toBeUndefined();
	});
	it("returns content for an existing path", () => {
		const result = readOnDiskOrUndefined(CLEAN_FIXTURE);
		expect(result).toBe(CLEAN_CONTENT);
	});
	it("returns undefined when the path exists but cannot be read as a file (directory)", () => {
		// FIXTURE_DIR exists (existsSync true) but readFileSync throws EISDIR,
		// driving the catch path that swallows the error and returns undefined.
		expect(readOnDiskOrUndefined(FIXTURE_DIR)).toBeUndefined();
	});
});
