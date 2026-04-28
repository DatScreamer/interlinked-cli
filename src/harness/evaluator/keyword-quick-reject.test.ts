import { describe, expect, it } from "vitest";
import type { GuardRule } from "../types.js";
import { commandKeywordTokens, shouldEvaluateByKeywords } from "./keyword-quick-reject.js";

function makeRule(keywords?: string[]): GuardRule {
	return {
		id: "test",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		action: "block",
		patterns: [],
		reason: "test",
		severity: "high",
		keywords,
	};
}

describe("commandKeywordTokens", () => {
	it("tokenizes whitespace-separated words", () => {
		const tokens = commandKeywordTokens("git push --force");
		expect(tokens.has("git")).toBe(true);
		expect(tokens.has("push")).toBe(true);
		expect(tokens.has("--force")).toBe(true);
	});

	it("lowercases tokens", () => {
		const tokens = commandKeywordTokens("KUBECTL DELETE namespace");
		expect(tokens.has("kubectl")).toBe(true);
		expect(tokens.has("delete")).toBe(true);
	});

	it("splits on shell metacharacters", () => {
		const tokens = commandKeywordTokens("ls | grep foo && rm bar");
		expect(tokens.has("ls")).toBe(true);
		expect(tokens.has("grep")).toBe(true);
		expect(tokens.has("foo")).toBe(true);
		expect(tokens.has("rm")).toBe(true);
		expect(tokens.has("bar")).toBe(true);
	});

	it("treats quotes as token boundaries", () => {
		// `bash -c 'while :; do :; done'` should expose `while` as its own token
		// so rules keyed on `while` still fire on `-c`-wrapped shell commands.
		const tokens = commandKeywordTokens("bash -c 'while :; do :; done'");
		expect(tokens.has("while")).toBe(true);
		expect(tokens.has("do")).toBe(true);
		expect(tokens.has("done")).toBe(true);
	});

	it("treats double quotes as token boundaries", () => {
		const tokens = commandKeywordTokens('echo "terraform state rm foo"');
		expect(tokens.has("terraform")).toBe(true);
		expect(tokens.has("state")).toBe(true);
		expect(tokens.has("rm")).toBe(true);
		expect(tokens.has("foo")).toBe(true);
	});

	it("returns empty set for empty input", () => {
		expect(commandKeywordTokens("").size).toBe(0);
		expect(commandKeywordTokens("   ").size).toBe(0);
	});

	it("emits path basenames so absolute-path commands hit basename keywords", () => {
		// Regression: `/bin/dd if=...` produced a single token `/bin/dd`,
		// the keyword set never contained `dd`, and the destructive-dd rule
		// silently skipped its regex via the quick-reject pre-filter. Rules
		// keyworded by the basename must still fire.
		const tokens = commandKeywordTokens("/bin/dd if=/dev/zero of=/dev/sda");
		expect(tokens.has("dd")).toBe(true);
		// Original full path is still emitted so quoted/full-path keywords
		// continue to work.
		expect(tokens.has("/bin/dd")).toBe(true);
	});

	it("emits path basenames for relative invocations (`./terraform`)", () => {
		const tokens = commandKeywordTokens("./terraform state rm aws_iam_user.foo");
		expect(tokens.has("terraform")).toBe(true);
		expect(tokens.has("state")).toBe(true);
		expect(tokens.has("rm")).toBe(true);
	});

	it("emits each segment of a multi-component path", () => {
		const tokens = commandKeywordTokens("/usr/bin/docker system prune --force");
		expect(tokens.has("docker")).toBe(true);
		expect(tokens.has("system")).toBe(true);
		expect(tokens.has("prune")).toBe(true);
		// Intermediate segments also surface (consistent emission).
		expect(tokens.has("usr")).toBe(true);
		expect(tokens.has("bin")).toBe(true);
	});
});

describe("shouldEvaluateByKeywords", () => {
	it("evaluates a rule whose keyword is present", () => {
		const rule = makeRule(["kubectl"]);
		const tokens = commandKeywordTokens("kubectl delete namespace foo");
		expect(shouldEvaluateByKeywords(rule, tokens)).toBe(true);
	});

	it("skips a rule whose keyword is absent", () => {
		const rule = makeRule(["kubectl"]);
		const tokens = commandKeywordTokens("npm install");
		expect(shouldEvaluateByKeywords(rule, tokens)).toBe(false);
	});

	it("evaluates a rule when ANY keyword matches (OR semantics)", () => {
		const rule = makeRule(["docker", "podman"]);
		const tokens = commandKeywordTokens("podman volume rm myvol");
		expect(shouldEvaluateByKeywords(rule, tokens)).toBe(true);
	});

	it("always evaluates a rule with no keywords (always-eval semantics)", () => {
		const rule = makeRule([]);
		const tokens = commandKeywordTokens("ls -la");
		expect(shouldEvaluateByKeywords(rule, tokens)).toBe(true);
	});

	it("always evaluates a rule with keywords undefined (always-eval semantics)", () => {
		const rule = makeRule(undefined);
		const tokens = commandKeywordTokens("ls -la");
		expect(shouldEvaluateByKeywords(rule, tokens)).toBe(true);
	});

	it("matches case-insensitively", () => {
		const rule = makeRule(["KubeCTL"]);
		const tokens = commandKeywordTokens("kubectl get pods");
		expect(shouldEvaluateByKeywords(rule, tokens)).toBe(true);
	});

	it("does not match a keyword that is a substring of a token", () => {
		// `kube` is a substring of `kubectl` but should not match.
		const rule = makeRule(["kube"]);
		const tokens = commandKeywordTokens("kubectl get pods");
		expect(shouldEvaluateByKeywords(rule, tokens)).toBe(false);
	});
});
