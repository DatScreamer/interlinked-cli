// Pattern-level tests for the cohort git-discipline rule pack. The predicate
// gating (dormant below 2 active agents) is covered in active-when.test.ts and
// command-guard-parity.test.ts; here we pin each rule's REGEX against the
// carve-outs it promises: stash list/show and checkout -b creation. (add -A / commit -a are owned by
// git-session-scope-gate — per-file ownership beats a blanket cohort block.)

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { COHORT_DISCIPLINE_RULES } from "./builtin-rules-cohort.js";

function ruleRegex(id: string): RegExp {
	const rule = COHORT_DISCIPLINE_RULES.find((r) => r.id === id);
	if (!rule) throw new Error(`missing rule ${id}`);
	const pattern = nonNull(rule.patterns[0]);
	return new RegExp(pattern.regex, pattern.flags ?? "");
}

describe("cohort rule pack shape", () => {
	it("every rule is predicate-gated at >=2 active agents and blocks", () => {
		expect(COHORT_DISCIPLINE_RULES.length).toBe(3);
		for (const rule of COHORT_DISCIPLINE_RULES) {
			expect(rule.active_when?.predicate?.name).toBe("active_agent_count_at_least");
			expect(rule.action).toBe("block");
			expect(rule.category).toBe("cohort-discipline");
			expect(rule.patterns[0]?.executed_only).toBe(true);
		}
	});
});

describe("builtin-cohort-git-stash", () => {
	const re = ruleRegex("builtin-cohort-git-stash");
	it("matches stash / stash push / stash pop / stash apply / stash save", () => {
		expect(re.test("git stash")).toBe(true);
		expect(re.test("git stash push -m wip")).toBe(true);
		expect(re.test("git stash pop")).toBe(true);
		expect(re.test("git stash apply stash@{0}")).toBe(true);
		expect(re.test("git stash save wip")).toBe(true);
	});
	it("carves out the read-only forms", () => {
		expect(re.test("git stash list")).toBe(false);
		expect(re.test("git stash show -p stash@{0}")).toBe(false);
	});
});

describe("builtin-cohort-git-rebase", () => {
	const re = ruleRegex("builtin-cohort-git-rebase");
	it("matches plain and interactive rebase", () => {
		expect(re.test("git rebase main")).toBe(true);
		expect(re.test("git rebase -i HEAD~3")).toBe(true);
	});
	it("does not match unrelated commands", () => {
		expect(re.test("git rev-parse HEAD")).toBe(false);
	});
});



describe("builtin-cohort-git-switch-branch", () => {
	const re = ruleRegex("builtin-cohort-git-switch-branch");
	it("matches branch switches", () => {
		expect(re.test("git checkout main")).toBe(true);
		expect(re.test("git switch feature/x")).toBe(true);
	});
	it("allows creation forms and flag-first invocations", () => {
		expect(re.test("git checkout -b feature/x")).toBe(false);
		expect(re.test("git switch -c feature/x")).toBe(false);
		expect(re.test("git checkout -- .")).toBe(false); // owned by builtin-git-checkout-dot
	});
});
