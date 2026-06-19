// Regression tests for process/filesystem guard rules.
//
// builtin-git-clone-into-tree: the original pattern used an unbounded `.*`
// walker, so on a compound command the *final token of the whole line* was
// read as the clone destination — `git clone <url> /tmp/x && git -C /tmp/x
// rev-list --count HEAD` soft-blocked on `HEAD` (2026-06-12, live session,
// twice — including on the exact command the rule's own suggestion text
// proposes). Same defect class destructive_command_guard fixed in their
// #124 ("bound the walker to a single command"); see
// docs/external-pulse/destructive-command-guard.md. The fix bounds the
// walker to the clone's own shell segment.

import { describe, expect, it } from "vitest";
import { PROCESS_AND_FILESYSTEM_RULES } from "../builtin-rules-processes.js";

const cloneRule = PROCESS_AND_FILESYSTEM_RULES.find((r) => r.id === "builtin-git-clone-into-tree");

function cloneRuleMatches(command: string): boolean {
	if (!cloneRule) throw new Error("builtin-git-clone-into-tree rule missing");
	return cloneRule.patterns.some((p) => new RegExp(p.regex, p.flags || "i").test(command));
}

describe("builtin-git-clone-into-tree — registry shape", () => {
	it("exists and stays a soft_block (in-tree clones are sometimes intentional)", () => {
		expect(cloneRule).toBeDefined();
		expect(cloneRule?.action).toBe("soft_block");
	});
});

describe("builtin-git-clone-into-tree — fires on in-tree clones", () => {
	it("matches a bare relative destination", () => {
		expect(cloneRuleMatches("git clone https://github.com/x/y.git myrepo")).toBe(true);
	});
	it("matches a nested relative destination inside a compound command", () => {
		expect(cloneRuleMatches("git clone https://github.com/x/y.git vendor/y && cd vendor/y")).toBe(
			true,
		);
	});
	it("matches with leading flags before the URL", () => {
		expect(cloneRuleMatches("git clone --depth 1 https://github.com/x/y.git sub.dir")).toBe(true);
	});
	it("matches when the clone is not the first segment", () => {
		expect(cloneRuleMatches("cd /work && git clone https://github.com/x/y.git localdir")).toBe(
			true,
		);
	});
	it("matches a relative destination followed by a semicolon segment", () => {
		expect(cloneRuleMatches("git clone https://github.com/x/y.git target; ls target")).toBe(true);
	});
});

describe("builtin-git-clone-into-tree — does not span shell segment boundaries", () => {
	it("ignores tokens after && when the destination is absolute (live FP, 2026-06-12)", () => {
		expect(
			cloneRuleMatches(
				'rm -rf /tmp/dcg && git clone --quiet https://github.com/x/y /tmp/dcg && git -C /tmp/dcg log --oneline | head -30 && echo "---TOTAL---" && git -C /tmp/dcg rev-list --count HEAD',
			),
		).toBe(false);
	});
	it("ignores pipe tails and fd redirects (live FP, 2026-06-12)", () => {
		expect(
			cloneRuleMatches(
				"git clone https://github.com/x/y /tmp/dcg 2>&1 | tail -2 && git -C /tmp/dcg log --oneline | head -40",
			),
		).toBe(false);
	});
	it("ignores relative paths in later segments after a safe clone", () => {
		expect(cloneRuleMatches("git clone https://github.com/x/y.git /tmp/x && cat notes.txt")).toBe(
			false,
		);
	});
});

describe("builtin-git-clone-into-tree — safe destinations stay allowed", () => {
	it("allows an absolute destination", () => {
		expect(cloneRuleMatches("git clone https://github.com/x/y.git /tmp/repo")).toBe(false);
	});
	it("allows a home-relative destination", () => {
		expect(cloneRuleMatches("git clone https://github.com/x/y.git ~/code/y")).toBe(false);
	});
	it("allows an ssh-style URL with an absolute destination", () => {
		expect(cloneRuleMatches("git clone git@github.com:x/y.git /abs/path")).toBe(false);
	});
	it("allows trailing flag values after a safe destination", () => {
		expect(cloneRuleMatches("git clone https://github.com/x/y.git /tmp/x --depth 1")).toBe(false);
		expect(cloneRuleMatches("git clone https://github.com/x/y.git /tmp/x --origin upstream")).toBe(
			false,
		);
	});
	it("stays silent on a bare URL clone (known pre-existing gap, pinned so a future fix is deliberate)", () => {
		expect(cloneRuleMatches("git clone https://github.com/x/y.git")).toBe(false);
	});
});
