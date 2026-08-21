import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanCIFilesForRecurrences, scanCodebaseForRecurrences } from "./recurrence-scanner.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
	const root = mkdtempSync(join(tmpdir(), "recurrence-scanner-kill-"));
	roots.push(root);
	return root;
}

// interlinked: defer data_clump -- small local test fixture helper
function fixture(root: string, path: string, content: string): void {
	const absolute = join(root, path);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content);
}

function workflow(lines: string[]): string {
	return ["name: kill-suite", "steps:", ...lines.map((line) => `  - run: ${line}`)].join("\n");
}

describe("recurrence-scanner mutation kills — default roots/extensions", () => {
	// test-contract: boundary — the default extension allowlist excludes non-matching
	// files, and blanking any single default extension string (or the containment
	// check itself) must not admit them — `"".endsWith("")` is vacuously true, so a
	// single emptied entry would otherwise let every file through.
	// test-contract: boundary — DEFAULT_SCAN_ROOTS restricts the walk to "src"; a
	// blanked root string would resolve to `cwd` itself and pull in top-level files.
	it("scans only default roots/extensions and skips non-matching files", () => {
		const root = sandbox();
		fixture(root, "src/hit.ts", "export const bad = eval('1');\n");
		fixture(root, "src/ignored.txt", "export const bad = eval('2');\n");
		fixture(root, "top.ts", "export const bad = eval('3');\n");

		const findings = scanCodebaseForRecurrences({ cwd: root });

		expect(findings.some((f) => f.file === "src/hit.ts" && f.check_id === "eval_usage")).toBe(true);
		expect(findings.some((f) => f.file === "src/ignored.txt")).toBe(false);
		expect(findings.some((f) => f.file === "top.ts")).toBe(false);
	});

	// test-contract: boundary — every SKIP_DIR_NAMES entry (and the has()-gate itself)
	// must keep its subtree out of the walk; blanking one entry, the whole array, or
	// the containment check would each leak exactly that class of directory.
	it("skips every protected subtree nested under a scanned root", () => {
		const root = sandbox();
		const protectedDirs = [
			"node_modules",
			"dist",
			"build",
			"vendor",
			".next",
			".git",
			".interlinked",
			"coverage",
		];
		for (const dir of protectedDirs) {
			fixture(root, `src/${dir}/marker.ts`, "export const bad = eval('x');\n");
		}
		fixture(root, "src/real.ts", "export const bad = eval('y');\n");

		const findings = scanCodebaseForRecurrences({ cwd: root });

		expect(findings.some((f) => f.file === "src/real.ts" && f.check_id === "eval_usage")).toBe(true);
		const leaked = findings.filter((f) => f.file !== "src/real.ts");
		expect(leaked).toEqual([]);
	});
});

describe("recurrence-scanner mutation kills — destructiveBashRules + CI scan", () => {
	// test-contract: invariant — destructiveBashRules() admits only enabled
	// block/ask/soft_block rules on a PreToolUse-or-both trigger whose tool_match
	// resolves (via .some, not .every) to bash/shell/run_command/wildcard; every
	// sub-comparison in that resolution (equality direction, literal text, the
	// full OR chain) gates a distinct rule below.
	// test-contract: public-api — the externality gate (`tool_externality`) is
	// evaluated with the real `toolName`/`toolInput` the caller passed, not a
	// blanked stand-in.
	// test-contract: boundary — the emitted finding text is `command.slice(0, 200)`,
	// not the raw unbounded command.
	it("filters destructive-bash rules and truncates long finding text", () => {
		const root = sandbox();
		const rules = [
			{
				id: "bash-rule",
				enabled: true,
				action: "block",
				trigger: "PreToolUse",
				tool_match: ["Bash", "Postgres"],
				patterns: [{ field: "command", regex: "bash-marker" }],
				reason: "r",
				severity: "high",
			},
			{
				id: "shell-rule",
				enabled: true,
				action: "ask",
				trigger: "PreToolUse",
				tool_match: ["Shell"],
				patterns: [{ field: "command", regex: "shell-marker" }],
				reason: "r",
				severity: "high",
			},
			{
				id: "run-rule",
				enabled: true,
				action: "soft_block",
				trigger: "PreToolUse",
				tool_match: ["run_command"],
				patterns: [{ field: "command", regex: "run-marker" }],
				reason: "r",
				severity: "high",
			},
			{
				id: "wild-rule",
				enabled: true,
				action: "block",
				trigger: "both",
				tool_match: ["*"],
				patterns: [{ field: "command", regex: "wild-marker" }],
				reason: "r",
				severity: "high",
			},
			{
				id: "nope-rule",
				enabled: true,
				action: "block",
				trigger: "PreToolUse",
				tool_match: ["NopeTool"],
				patterns: [{ field: "command", regex: "nope-marker" }],
				reason: "r",
				severity: "high",
			},
			{
				id: "disabled-rule",
				enabled: false,
				action: "block",
				trigger: "PreToolUse",
				tool_match: ["Bash"],
				patterns: [{ field: "command", regex: "disabled-marker" }],
				reason: "r",
				severity: "high",
			},
			{
				id: "warn-rule",
				enabled: true,
				action: "warn",
				trigger: "PreToolUse",
				tool_match: ["Bash"],
				patterns: [{ field: "command", regex: "warn-marker" }],
				reason: "r",
				severity: "high",
			},
			{
				id: "post-rule",
				enabled: true,
				action: "block",
				trigger: "PostToolUse",
				tool_match: ["Bash"],
				patterns: [{ field: "command", regex: "post-marker" }],
				reason: "r",
				severity: "high",
			},
			{
				id: "ext-rule",
				enabled: true,
				action: "block",
				trigger: "PreToolUse",
				tool_match: ["Bash"],
				tool_externality: ["external_action"],
				patterns: [{ field: "command", regex: "ext-rule-marker" }],
				reason: "r",
				severity: "high",
			},
			{
				id: "long-rule",
				enabled: true,
				action: "block",
				trigger: "PreToolUse",
				tool_match: ["Bash"],
				patterns: [{ field: "command", regex: "long-marker" }],
				reason: "r",
				severity: "high",
			},
		];
		fixture(root, ".interlinked/guard-rules.json", JSON.stringify({ rules }));

		const longCommand = `long-marker ${"x".repeat(300)}`;
		const commands = [
			"echo bash-marker",
			"echo shell-marker",
			"echo run-marker",
			"echo wild-marker",
			"echo nope-marker",
			"echo disabled-marker",
			"echo warn-marker",
			"echo post-marker",
			"npm publish ext-rule-marker",
			longCommand,
		];
		fixture(root, ".github/workflows/ci.yml", workflow(commands));

		const findings = scanCIFilesForRecurrences(root);

		expect(findings.map((f) => f.check_id)).toEqual([
			"bash-rule",
			"shell-rule",
			"run-rule",
			"wild-rule",
			"ext-rule",
			"long-rule",
		]);
		expect(findings.map((f) => f.text)).toEqual([
			"echo bash-marker",
			"echo shell-marker",
			"echo run-marker",
			"echo wild-marker",
			"npm publish ext-rule-marker",
			longCommand.slice(0, 200),
		]);
		const longFinding = findings[findings.length - 1];
		expect(longFinding?.text.length).toBe(200);
		expect(longFinding?.text).not.toBe(longCommand);
	});
});
