import { describe, expect, it } from "vitest";
import {
	extractGithubLogins,
	isActiveRepo,
	loginCandidates,
	rankRepos,
	summarizeRepo,
	verifyMatch,
} from "./discover-yc-oss-repos.mjs";

const NOW = Date.UTC(2026, 4, 8);
const DAY_MS = 86_400_000;
const recentISO = (daysAgo) => new Date(NOW - daysAgo * DAY_MS).toISOString();

function mockRepo(overrides = {}) {
	return {
		name: "demo-repo",
		full_name: "acme/demo-repo",
		description: "demo",
		language: "TypeScript",
		stargazers_count: 0,
		pushed_at: recentISO(10),
		size: 500,
		default_branch: "main",
		html_url: "https://github.com/acme/demo-repo",
		fork: false,
		archived: false,
		disabled: false,
		...overrides,
	};
}

describe("loginCandidates", () => {
	it("dedupes slug and name-derived candidates", () => {
		const cands = loginCandidates({ slug: "menza", name: "Menza" });
		expect(cands).toContain("menza");
		expect(new Set(cands).size).toBe(cands.length);
	});

	it("strips spaces and punctuation from name candidates", () => {
		const cands = loginCandidates({
			slug: "gru-space",
			name: "Galactic Resource Utilization Space, Inc.",
		});
		expect(cands).toContain("gru-space");
		expect(cands.some((c) => /^galactic/.test(c))).toBe(true);
	});

	it("filters out non-GitHub-shaped candidates", () => {
		const cands = loginCandidates({ slug: "-leading-dash", name: "" });
		expect(cands.every((c) => /^[a-z0-9]/.test(c))).toBe(true);
	});
});

describe("isActiveRepo", () => {
	it("excludes forks, archived, and disabled repos", () => {
		expect(isActiveRepo(mockRepo({ fork: true }), NOW)).toBe(false);
		expect(isActiveRepo(mockRepo({ archived: true }), NOW)).toBe(false);
		expect(isActiveRepo(mockRepo({ disabled: true }), NOW)).toBe(false);
	});

	it("excludes tiny placeholder repos", () => {
		expect(isActiveRepo(mockRepo({ size: 1 }), NOW)).toBe(false);
	});

	it("excludes repos not pushed within the recent window", () => {
		expect(isActiveRepo(mockRepo({ pushed_at: recentISO(400) }), NOW)).toBe(false);
	});

	it("keeps healthy active repos", () => {
		expect(isActiveRepo(mockRepo(), NOW)).toBe(true);
	});
});

describe("rankRepos", () => {
	it("orders by recent push then by stars", () => {
		const ranked = rankRepos(
			[
				mockRepo({ name: "older-many-stars", pushed_at: recentISO(30), stargazers_count: 1000 }),
				mockRepo({ name: "newer-no-stars", pushed_at: recentISO(2), stargazers_count: 0 }),
				mockRepo({ name: "newest-some-stars", pushed_at: recentISO(1), stargazers_count: 5 }),
				mockRepo({ name: "stale", pushed_at: recentISO(800), stargazers_count: 9999 }),
			],
			NOW,
		);
		expect(ranked.map((r) => r.name)).toEqual([
			"newest-some-stars",
			"newer-no-stars",
			"older-many-stars",
		]);
	});
});

describe("summarizeRepo", () => {
	it("produces stable shape with scannable flag from language", () => {
		const summary = summarizeRepo(mockRepo({ language: "TypeScript" }));
		expect(summary.scannable).toBe(true);
		const nonScannable = summarizeRepo(mockRepo({ language: "Lua" }));
		expect(nonScannable.scannable).toBe(false);
	});

	it("tolerates null language", () => {
		const summary = summarizeRepo(mockRepo({ language: null }));
		expect(summary.language).toBe(null);
		expect(summary.scannable).toBe(false);
	});
});

describe("extractGithubLogins", () => {
	it("pulls bare github.com/<login> matches", () => {
		const text = "Find us on https://github.com/eigenpal and https://github.com/eigenpal/docx-editor.";
		expect(extractGithubLogins(text)).toEqual(["eigenpal"]);
	});

	it("filters reserved github paths like /pricing /features /about", () => {
		const text = "see github.com/pricing and github.com/about and github.com/realorg";
		expect(extractGithubLogins(text)).toEqual(["realorg"]);
	});

	it("dedupes case-insensitively", () => {
		const text = "github.com/Acme github.com/acme github.com/ACME/repo";
		expect(extractGithubLogins(text)).toEqual(["acme"]);
	});

	it("returns empty for input with no github links", () => {
		expect(extractGithubLogins("nothing to see here")).toEqual([]);
	});

	it("returns empty for null/empty input", () => {
		expect(extractGithubLogins(null)).toEqual([]);
		expect(extractGithubLogins("")).toEqual([]);
	});
});

describe("verifyMatch", () => {
	const company = {
		slug: "menza",
		name: "Menza",
		website: "https://menza.ai/",
	};

	it("flags slug-exact when login matches the slug", () => {
		const reasons = verifyMatch({ login: "menza" }, company);
		expect(reasons).toContain("slug-exact");
	});

	it("flags website-match when blog/url contains company host", () => {
		const reasons = verifyMatch(
			{ login: "menzateam", blog: "https://menza.ai/team" },
			company,
		);
		expect(reasons.some((r) => r.startsWith("website-match"))).toBe(true);
	});

	it("flags name-match when bio/description contains company name", () => {
		const reasons = verifyMatch(
			{ login: "someorg", description: "We are Menza, an AI analyst" },
			company,
		);
		expect(reasons).toContain("name-match");
	});

	it("returns empty when nothing matches", () => {
		expect(verifyMatch({ login: "unrelated" }, company)).toEqual([]);
	});

	it("tolerates malformed company.website without throwing", () => {
		expect(() =>
			verifyMatch({ login: "x" }, { slug: "x", name: "X", website: "not a url" }),
		).not.toThrow();
	});
});
