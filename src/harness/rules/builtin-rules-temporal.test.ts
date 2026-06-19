// Temporal-precondition rules — registry shape + the force-push pattern
// hardening that landed during the destructive_command_guard adoption
// (segment-bounded walker, executed_only masking, bundled short flags).
// The temporal GATING (requires_prior / forbids_after) is exercised through
// the evaluator in temporal-rules.test.ts; here we pin the raw patterns.

import { describe, expect, it } from "vitest";
import { extractScannableText } from "../evaluator/spans.js";
import { TEMPORAL_PRECONDITION_RULES } from "./builtin-rules-temporal.js";

const forcePush = TEMPORAL_PRECONDITION_RULES.find(
	(r) => r.id === "builtin-git-force-push-requires-inspection",
);

/** Mirror the evaluator's executed_only projection so these unit tests match
 *  live behavior (quoted/heredoc-data mentions are masked before matching). */
function ruleMatches(command: string): boolean {
	if (!forcePush) throw new Error("force-push rule missing");
	const positives = forcePush.patterns.filter((p) => !p.negate);
	const negatives = forcePush.patterns.filter((p) => p.negate);
	const project = (p: { executed_only?: boolean }) =>
		p.executed_only ? extractScannableText(command) : command;
	const anyPositive = positives.some((p) =>
		new RegExp(p.regex, p.flags || "i").test(project(p)),
	);
	if (!anyPositive) return false;
	return !negatives.some((p) => new RegExp(p.regex, p.flags || "i").test(project(p)));
}

describe("TEMPORAL_PRECONDITION_RULES — registry shape", () => {
	it("exports the three temporal rules", () => {
		const ids = TEMPORAL_PRECONDITION_RULES.map((r) => r.id);
		expect(ids).toContain("builtin-git-force-push-requires-inspection");
		expect(ids).toContain("builtin-rm-requires-prior-inspection");
		expect(ids).toContain("builtin-npm-publish-requires-tests-pass");
	});

	it("every rule declares a temporal predicate", () => {
		for (const r of TEMPORAL_PRECONDITION_RULES) {
			expect(r.requires_prior || r.forbids_after).toBeTruthy();
		}
	});
});

describe("force-push pattern — fires on real force pushes", () => {
	it("matches --force", () => {
		expect(ruleMatches("git push --force origin main")).toBe(true);
	});
	it("matches a bare -f", () => {
		expect(ruleMatches("git push -f origin main")).toBe(true);
	});
	it("matches bundled short flags (-uf, -fq, -vf)", () => {
		expect(ruleMatches("git push -uf origin main")).toBe(true);
		expect(ruleMatches("git push -fq origin main")).toBe(true);
		expect(ruleMatches("git push -vf")).toBe(true);
	});
	it("matches --force after other flags/args", () => {
		expect(ruleMatches("git push origin main --force")).toBe(true);
		expect(ruleMatches("git push --set-upstream origin feat --force")).toBe(true);
	});
});

describe("force-push pattern — does not fire on safe variants", () => {
	it("ignores --force-with-lease", () => {
		expect(ruleMatches("git push --force-with-lease origin main")).toBe(false);
	});
	it("ignores --force-with-lease --force-if-includes", () => {
		expect(ruleMatches("git push --force-with-lease --force-if-includes")).toBe(false);
	});
	it("ignores a plain push", () => {
		expect(ruleMatches("git push origin main")).toBe(false);
	});
});

describe("force-push pattern — boundary + data discipline", () => {
	it("does not span a shell separator (echo --force after &&)", () => {
		expect(ruleMatches("git push origin main && echo --force")).toBe(false);
	});
	it("does not fire on a quoted mention (executed_only masking)", () => {
		expect(ruleMatches('echo "git push --force"')).toBe(false);
		expect(ruleMatches("git commit -m 'mention git push --force in the message'")).toBe(false);
	});
	it("still fires inside an inline-exec payload (bash -c)", () => {
		expect(ruleMatches("bash -c 'git push --force origin main'")).toBe(true);
	});
});
