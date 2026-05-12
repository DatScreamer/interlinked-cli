// ===========================================
// CI-vs-pre-push pipeline parity
// ===========================================
//
// Locks in the invariant the user articulated after the docs:check
// red-CI incident (commit 5452fac → c2eef67): "the interlinked-cli
// tool is supposed to check everything that could go wrong BEFORE
// it's written to disk, and certainly before it's committed and
// pushed." The pre-push hook is the local mirror of CI; this test
// guarantees no new CI step can ship without either being wired
// into the hook or being explicitly opted out with a rationale.
//
// How it works:
//   1. Parse `.github/workflows/ci.yml` and extract every `- name:`
//      step from the matrix job (one entry per step).
//   2. Compare against the `CI_STEPS` allowlist below. If CI adds
//      a step, the test fails with the new step's name — the
//      change-author must update this file (either wire it into
//      the pre-push hook OR add a skip + rationale).
//   3. For each `mirror: "pre-push"` entry, assert the listed
//      `command` substring appears in `scripts/git-hooks/pre-push`
//      so a hook drift (someone removes a check) also breaks here.
//
// Maintenance contract: when you add or remove a CI step in
// .github/workflows/ci.yml, update `CI_STEPS` in lockstep. If your
// new step is a real correctness gate, default to `mirror: "pre-push"`
// and add it to the hook script. Use `mirror: "skip"` only for
// release-time / package-shape checks that don't gate the coding
// loop, and always attach a one-line `reason`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github", "workflows", "ci.yml");
const PRE_PUSH_HOOK = resolve(REPO_ROOT, "scripts", "git-hooks", "pre-push");

interface CiStep {
	/** Exact `name:` value in ci.yml. */
	name: string;
	/** Where this CI step is mirrored locally. */
	mirror: "pre-push" | "skip";
	/** When mirror === "pre-push": substring of the command that must
	 *  appear in the pre-push hook script. */
	command?: string;
	/** When mirror === "skip": one-line rationale for not running
	 *  locally. Surface answer for "why isn't this in pre-push?". */
	reason?: string;
}

const CI_STEPS: readonly CiStep[] = [
	{ name: "Checkout", mirror: "skip", reason: "git checkout — runner setup, not a check" },
	{
		name: "Setup Node.js ${{ matrix.node }}",
		mirror: "skip",
		reason: "Node toolchain provision — runner setup, not a check",
	},
	{
		name: "Install dependencies",
		mirror: "skip",
		reason: "npm ci — pre-push runs against the existing dev install",
	},
	{ name: "Typecheck", mirror: "pre-push", command: "npm run typecheck:stable" },
	{
		name: "Doc accuracy (landing + README vs source)",
		mirror: "pre-push",
		command: "npm run docs:check",
	},
	{ name: "Test", mirror: "pre-push", command: "npm test" },
	{
		name: "Build",
		mirror: "skip",
		reason: "build artifact — typecheck already covers source correctness; build itself is release-shape",
	},
	{
		name: "Lint package with publint",
		mirror: "skip",
		reason: "publint — package.json shape check; release-time only",
	},
	{
		name: "Check types with arethetypeswrong",
		mirror: "skip",
		reason: "attw — types-publish surface check; release-time only",
	},
	{
		name: "Pack dry-run",
		mirror: "skip",
		reason: "npm pack --dry-run — release-time tarball smoke",
	},
	{
		name: "Tarball install smoke test",
		mirror: "skip",
		reason: "full install-from-tarball walkthrough — too slow for pre-push (~minute)",
	},
	{
		name: "Onboarding smoke test (git-clone install path)",
		mirror: "skip",
		reason: "git-clone install walkthrough — too slow for pre-push (~minute)",
	},
];

/** Extract every `- name: <step>` from the matrix job. Strips the
 *  leading `- name:` and any trailing whitespace. Doesn't try to
 *  parse YAML structure (no dependency), just lexical extraction
 *  of step names — the ordering and uniqueness of `- name:` lines
 *  inside the steps block is the only thing we need to match. */
function extractCiStepNames(yaml: string): string[] {
	const names: string[] = [];
	const stepRe = /^\s{6}- name:\s*(.+?)\s*$/gm;
	let m: RegExpExecArray | null = stepRe.exec(yaml);
	while (m !== null) {
		names.push(m[1]);
		m = stepRe.exec(yaml);
	}
	return names;
}

describe("CI ↔ pre-push pipeline parity", () => {
	const yaml = readFileSync(CI_WORKFLOW, "utf-8");
	const hook = readFileSync(PRE_PUSH_HOOK, "utf-8");
	const ciStepNamesInYaml = extractCiStepNames(yaml);

	it("extracts at least one step from ci.yml (regex sanity check)", () => {
		expect(ciStepNamesInYaml.length).toBeGreaterThan(0);
	});

	it("every step in ci.yml is declared in CI_STEPS", () => {
		const declared = new Set(CI_STEPS.map((s) => s.name));
		const undeclared = ciStepNamesInYaml.filter((n) => !declared.has(n));
		expect(undeclared).toEqual([]);
	});

	it("every entry in CI_STEPS exists in ci.yml", () => {
		const inYaml = new Set(ciStepNamesInYaml);
		const stale = CI_STEPS.filter((s) => !inYaml.has(s.name)).map((s) => s.name);
		expect(stale).toEqual([]);
	});

	it("CI_STEPS has no duplicate step names", () => {
		const seen = new Set<string>();
		const dupes: string[] = [];
		for (const s of CI_STEPS) {
			if (seen.has(s.name)) dupes.push(s.name);
			seen.add(s.name);
		}
		expect(dupes).toEqual([]);
	});

	describe("mirror: 'pre-push' entries appear in the hook script", () => {
		for (const step of CI_STEPS) {
			if (step.mirror !== "pre-push") continue;
			it(`hook contains the command for "${step.name}"`, () => {
				expect(step.command).toBeTruthy();
				expect(hook).toContain(step.command as string);
			});
		}
	});

	describe("mirror: 'skip' entries carry a rationale", () => {
		for (const step of CI_STEPS) {
			if (step.mirror !== "skip") continue;
			it(`"${step.name}" has a non-empty reason`, () => {
				expect(step.reason).toBeTruthy();
				expect((step.reason as string).trim().length).toBeGreaterThan(0);
			});
		}
	});
});
