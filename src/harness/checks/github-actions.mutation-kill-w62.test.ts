import { describe, expect, it } from "vitest";
import { checkGithubActionsInjection } from "./github-actions.js";

const WF = ".github/workflows/ci.yml";

describe("checkGithubActionsInjection — path gate (kills 277f150101cdf351, 567e3e9517b0fa61)", () => {
	it("P1: matches a backslash-separated workflow path (normalization must convert \\ to /)", () => {
		// If the "/" replacement string were mutated to "", backslashes would
		// be stripped instead of converted, and "repo\.github\workflows\ci.yml"
		// would collapse into a string that never matches the workflows regex.
		const filePath = "repo\\.github\\workflows\\ci.yml";
		const content = "run: echo ${{ github.head_ref }}";
		const result = checkGithubActionsInjection(content, filePath);
		expect(result.length).toBe(1);
	});

	it("N1: does not fire for a non-.yml/.yaml file even if it lives under .github/workflows/", () => {
		// If the /\.ya?ml$/i anchor were dropped, this path (ends in .bak, but
		// contains "ci.yaml" as a substring) would incorrectly pass the gate.
		const filePath = ".github/workflows/ci.yaml.bak";
		const content = "run: echo ${{ github.head_ref }}";
		expect(checkGithubActionsInjection(content, filePath)).toEqual([]);
	});

	it("P2: fires for an ordinary .yml workflow path (sanity baseline)", () => {
		const content = "run: echo ${{ github.head_ref }}";
		expect(checkGithubActionsInjection(content, WF).length).toBe(1);
	});
});

describe("checkGithubActionsInjection — vendored/fixture gate (kills ecbd200f8050a840)", () => {
	it("N2: does not fire inside a vendor/ tree even though the path otherwise qualifies", () => {
		const filePath = "vendor/.github/workflows/ci.yml";
		const content = "run: echo ${{ github.head_ref }}";
		expect(checkGithubActionsInjection(content, filePath)).toEqual([]);
	});
});

describe("checkGithubActionsInjection — dangerous-pattern regex quantifiers", () => {
	it("kills fab3caeb4fc3c37a: matches with zero whitespace right after ${{ in the event alt", () => {
		const content = "run: echo ${{github.event.issue.title}}";
		expect(checkGithubActionsInjection(content, WF).length).toBe(1);
	});

	it("kills 32bf5e6186a66a48: matches with zero whitespace right before the closing }} in the event alt", () => {
		const content = "run: echo ${{ github.event.issue.title}}";
		expect(checkGithubActionsInjection(content, WF).length).toBe(1);
	});

	it("kills 92740ea53a7e6a75: matches with zero whitespace right after ${{ in the head_ref alt", () => {
		const content = "run: echo ${{github.head_ref}}";
		expect(checkGithubActionsInjection(content, WF).length).toBe(1);
	});

	it("kills 4b9e06056296b093: matches with zero whitespace right before closing }} in the head_ref alt", () => {
		const content = "run: echo ${{ github.head_ref}}";
		expect(checkGithubActionsInjection(content, WF).length).toBe(1);
	});

	it("kills 42de8d9db2d17514 and 0c7a869a2578b37a: multi-digit pages index still matches", () => {
		// \d+ -> \d (single digit) or \d+ -> \D+ (non-digit) both break on a
		// two-digit numeric index.
		const content = "run: echo ${{ github.event.pages.42.page_name }}";
		expect(checkGithubActionsInjection(content, WF).length).toBe(1);
	});

	it("kills a7d384827a5cad2b and 1acb86d8bc8c9ea7: multi-digit commits index still matches", () => {
		const content = "run: echo ${{ github.event.commits.42.author.email }}";
		expect(checkGithubActionsInjection(content, WF).length).toBe(1);
	});
});

describe("checkGithubActionsInjection — match bookkeeping", () => {
	it("kills 7ca668ea183b662b: line numbers are computed by splitting on real newlines", () => {
		const content = "one\ntwo\nrun: echo ${{ github.head_ref }}\nfour\n";
		const result = checkGithubActionsInjection(content, WF);
		expect(result).toHaveLength(1);
		expect(result[0]?.line).toBe(3);
	});

	it("kills 9cd8fb4862e314f4: line number reflects the match's real position, not index 0", () => {
		const content = "# leading comment line\nrun: echo ${{ github.head_ref }}\n";
		const result = checkGithubActionsInjection(content, WF);
		expect(result).toHaveLength(1);
		expect(result[0]?.line).toBe(2);
	});

	it("kills ea9a15d7970997e4: line number counts only lines up to the match, not the whole file", () => {
		const content = "a\nrun: echo ${{ github.head_ref }}\nb\nc\nd\ne\n";
		const result = checkGithubActionsInjection(content, WF);
		expect(result).toHaveLength(1);
		expect(result[0]?.line).toBe(2);
	});

	it("kills aa6022b6ce813e3e and 4deb3229ef4036d0: caps output at exactly 10 matches", () => {
		const lines: string[] = [];
		for (let i = 0; i < 11; i++) {
			lines.push(`run: echo ${"$"}{{ github.event.commits.${i}.message }}`);
		}
		const content = lines.join("\n");
		const result = checkGithubActionsInjection(content, WF);
		expect(result).toHaveLength(10);
	});

	it("kills 964294be6ce3ca36: pushed entries carry both line and text fields", () => {
		const content = "run: echo ${{ github.head_ref }}";
		const result = checkGithubActionsInjection(content, WF);
		expect(result[0]?.line).toBe(1);
		expect(result[0]?.text).toContain("github.head_ref");
	});

	it("kills 91243b23ae04c71d and 1cf614a5360b578d: dedupes multiple matches on the same line", () => {
		const content =
			"run: echo ${{ github.event.issue.title }} and ${{ github.head_ref }}";
		const result = checkGithubActionsInjection(content, WF);
		expect(result).toHaveLength(1);
	});

	it("kills 9e38416b35a5c94b: match text is truncated to 150 characters", () => {
		const pad = "x".repeat(200);
		const content = `run: echo ${"$"}{{ github.head_ref }} ${pad}`;
		const result = checkGithubActionsInjection(content, WF);
		expect(result[0]?.text.length).toBe(150);
	});

	it("kills 334728a5b2b8f48e: match text is trimmed of surrounding whitespace", () => {
		const content = "    run: echo ${{ github.head_ref }}    ";
		const result = checkGithubActionsInjection(content, WF);
		expect(result[0]?.text.startsWith(" ")).toBe(false);
		expect(result[0]?.text.endsWith(" ")).toBe(false);
	});
});
