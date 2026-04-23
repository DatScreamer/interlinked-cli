// ===========================================
// clone-repo unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import {
	CLONE_TIMEOUT_MS,
	cloneRepo,
	isGitUrl,
	normalizeGitUrl,
	repoDisplayName,
	SHELL_META,
} from "./clone-repo.js";

describe("isGitUrl", () => {
	it("recognizes https URLs", () => {
		expect(isGitUrl("https://github.com/owner/repo")).toBe(true);
		expect(isGitUrl("http://example.com/owner/repo")).toBe(true);
	});

	it("recognizes ssh/git@ URLs", () => {
		expect(isGitUrl("git@github.com:owner/repo.git")).toBe(true);
		expect(isGitUrl("ssh://git@example.com/owner/repo")).toBe(true);
	});

	it("recognizes bare owner/repo host patterns", () => {
		expect(isGitUrl("github.com/owner/repo")).toBe(true);
	});

	it("recognizes .git suffix", () => {
		expect(isGitUrl("example.com/owner/repo.git")).toBe(true);
	});

	it("rejects plain filesystem paths", () => {
		expect(isGitUrl("/tmp/foo")).toBe(false);
		expect(isGitUrl("./local")).toBe(false);
	});
});

describe("normalizeGitUrl", () => {
	it("adds https:// when missing for bare host patterns", () => {
		expect(normalizeGitUrl("github.com/owner/repo")).toBe("https://github.com/owner/repo");
	});

	it("preserves URLs that already have a scheme", () => {
		expect(normalizeGitUrl("https://github.com/owner/repo")).toBe(
			"https://github.com/owner/repo",
		);
		expect(normalizeGitUrl("git@github.com:owner/repo")).toBe("git@github.com:owner/repo");
	});
});

describe("repoDisplayName", () => {
	it("extracts owner/repo from ssh URL", () => {
		expect(repoDisplayName("git@github.com:owner/repo.git")).toBe("owner/repo");
	});

	it("extracts owner/repo from https URL", () => {
		expect(repoDisplayName("https://github.com/owner/repo")).toBe("owner/repo");
		expect(repoDisplayName("https://github.com/owner/repo.git")).toBe("owner/repo");
	});

	it("falls back to the URL when no match", () => {
		expect(repoDisplayName("something-weird")).toBe("something-weird");
	});
});

describe("cloneRepo", () => {
	it("rejects URLs with shell metacharacters", () => {
		expect(() => cloneRepo("https://evil.com;rm -rf /", {})).toThrow(/shell metacharacters/);
	});

	it("rejects branches with shell metacharacters", () => {
		expect(() =>
			cloneRepo("https://github.com/owner/repo", { branch: "main$(whoami)" }),
		).toThrow(/shell metacharacters/);
	});
});

describe("SHELL_META and CLONE_TIMEOUT_MS", () => {
	it("flags semicolons and backticks", () => {
		expect(SHELL_META.test("foo;bar")).toBe(true);
		expect(SHELL_META.test("foo`bar`")).toBe(true);
	});

	it("defines a positive timeout", () => {
		expect(CLONE_TIMEOUT_MS).toBeGreaterThan(0);
	});
});
