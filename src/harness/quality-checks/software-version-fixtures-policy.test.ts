import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
const ALLOW_MARKER = "REAL_WORLD_VERSION_FIXTURE_OK";

const FAST_MOVING_FIXTURE_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
	{ label: "OpenAI numbered GPT model alias", re: /\bgpt-(?:4o|[0-9][A-Za-z0-9_.-]*)\b/i },
	{ label: "OpenAI numbered o-series model alias", re: /\bo[0-9](?:-[A-Za-z0-9_.-]+)?\b/i },
	{
		label: "Anthropic numbered Claude family alias",
		// Families enumerated (not `[a-z]+`) so synthetic fixtures like `claude-test-5`
		// stay allowed; fable/mythos added ahead of those models' release so tests
		// can't start encoding their real names either.
		re: /\bclaude-(?:opus|sonnet|haiku|fable|mythos)-[0-9][A-Za-z0-9_.-]*\b/i,
	},
	{ label: "Google numbered Gemini model alias", re: /\bgemini-[0-9][A-Za-z0-9_.-]*\b/i },
	{
		label: "API version date assignment",
		re: /\b(?:api[_-]?version|apiVersion)\b\s*[:=]\s*["']20[0-9]{2}-[0-9]{2}-[0-9]{2}/,
	},
];

describe("software version fixture policy", () => {
	it("keeps fast-moving real-world model/API names out of casual test fixtures", () => {
		const violations: string[] = [];
		for (const filePath of listTestFiles(SRC_ROOT)) {
			if (filePath === THIS_FILE) continue;
			const content = readFileSync(filePath, "utf-8");
			violations.push(...findVersionFixtureViolations(filePath, content));
		}

		expect(
			violations,
			[
				"Fast-moving real-world model/API names make tests encode stale product knowledge.",
				"Use synthetic names like vendor-model-v6, or add REAL_WORLD_VERSION_FIXTURE_OK with a source comment when the exact real name is the behavior under test.",
				violations.join("\n"),
			].join("\n"),
		).toEqual([]);
	});
});

function findVersionFixtureViolations(filePath: string, content: string): string[] {
	const violations: string[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = nonNull(lines[i]);
		if (line.includes(ALLOW_MARKER) || lines[i - 1]?.includes(ALLOW_MARKER)) continue;
		const match = FAST_MOVING_FIXTURE_PATTERNS.find(({ re }) => re.test(line));
		if (!match) continue;
		violations.push(`${relative(SRC_ROOT, filePath)}:${i + 1} ${match.label}: ${line.trim()}`);
	}
	return violations;
}

function listTestFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const path = `${dir}/${entry}`;
		const stat = statSync(path);
		if (stat.isDirectory()) out.push(...listTestFiles(path));
		else if (entry.endsWith(".test.ts")) out.push(path);
	}
	return out;
}
