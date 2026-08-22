import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	scanCIFilesForRecurrences,
	scanCodebaseForRecurrences,
	scanFilesForDetector,
} from "./recurrence-scanner.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
	const root = mkdtempSync(join(tmpdir(), "recurrence-scanner-contract-"));
	roots.push(root);
	return root;
}

function fixture(root: string, path: string, content: string): void {
	const absolute = join(root, path);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content);
}

function workflow(lines: string[]): string {
	return ["name: contracts", "steps:", ...lines.map((line) => `  - run: ${line}`)].join("\n");
}

describe("recurrence scanner mutation contracts", () => {
	// test-contract: public-api — every shipped destructive Bash detector must retain its public rule id, line, and extracted command.
	it("reports each destructive Bash pattern with exact finding metadata", () => {
		const root = sandbox();
		const commands = [
			"rm -rf /",
			"rm -rf *",
			"rm -rf .wrangler",
			"rm -rf node_modules; echo done",
			"git push origin main --force",
			"git push -uf origin main",
			"git reset --hard HEAD",
			"git clean -df",
			"kill -9 123",
			"kill 123 456",
			"kill $(pgrep node)",
			"pkill -TERM node",
			"lsof -ti:3000 | kill",
			"git checkout -- .",
			"git restore --worktree file.ts",
			"git branch -D old",
			"git stash clear",
		];
		fixture(root, ".github/workflows/destructive.yml", workflow(commands));
		const findings = scanCIFilesForRecurrences(root);
		const expected = [
			["builtin-rm-rf-root", commands[0]],
			["builtin-rm-rf-root", commands[1]],
			["builtin-rm-wrangler", commands[2]],
			["builtin-rm-node-modules", commands[3]],
			["builtin-git-force-push", commands[4]],
			["builtin-git-force-push", commands[5]],
			["builtin-git-reset-hard", commands[6]],
			["builtin-git-clean-f", commands[7]],
			["builtin-kill-signal", commands[8]],
			["builtin-kill-multi-pid", commands[9]],
			// `kill $(pgrep node)` matches both builtin-pgrep-xargs-kill and
			// builtin-kill-substitution; first-match order selects the more
			// specific pgrep rule (rules/builtin-rules-processes.ts array order).
			["builtin-pgrep-xargs-kill", commands[10]],
			["builtin-pkill-node", commands[11]],
			["builtin-kill-port", commands[12]],
			["builtin-git-checkout-dot", commands[13]],
			["builtin-git-restore-worktree", commands[14]],
			["builtin-git-branch-D", commands[15]],
			["builtin-git-stash-destroy", commands[16]],
		] as const;
		expect(findings).toHaveLength(expected.length);
		for (const [index, [check_id, text]] of expected.entries()) {
			expect(findings[index]).toEqual({
				file: ".github/workflows/destructive.yml",
				check_id,
				line: index + 3,
				text,
			});
		}
	});

	// test-contract: security — executed-only rules reject real commands but do not treat quoted data, comments, or cross-segment near-misses as execution.
	it("keeps quoting, whitespace, and shell-boundary near-misses safe", () => {
		const root = sandbox();
		const safe = [
			'echo "rm -rf /"',
			"echo 'git push --force'",
			"git push origin main --force-with-lease",
			"git push origin && echo --force",
			"rm -rf /tmp/cache",
			"rm -rf /var/tmp/cache",
			"git clean -n",
			"git branch -d old",
		];
		fixture(root, ".github/workflows/safe.yml", workflow(safe));
		expect(scanCIFilesForRecurrences(root)).toEqual([]);
	});

	// test-contract: invariant — only enabled block/ask/soft_block rules with PreToolUse or both and a recognized shell tool are evaluated.
	it("filters custom rules by enabled state, action, trigger, and tool match", () => {
		const root = sandbox();
		fixture(
			root,
			".interlinked/guard-rules.json",
			JSON.stringify({
				rules: [
					...[
						["ask-rule", true, "ask", "PreToolUse", ["BASH", "Other"]],
						["soft-rule", true, "soft_block", "PreToolUse", ["shell"]],
						["both-rule", true, "block", "both", ["run_command"]],
						["wild-rule", true, "block", "PreToolUse", ["*"]],
						["disabled-rule", false, "block", "PreToolUse", ["Bash"]],
						["warn-rule", true, "warn", "PreToolUse", ["Bash"]],
						["post-rule", true, "block", "PostToolUse", ["Bash"]],
						["wrong-tool-rule", true, "block", "PreToolUse", ["Other"]],
					].map(([id, enabled, action, trigger, tool_match]) => ({
						id,
						enabled,
						action,
						trigger,
						tool_match,
						patterns: [{ field: "command", regex: `${id}-marker` }],
						reason: `${id} reason`,
						severity: "high",
					})),
				],
			}),
		);
		const ids = ["ask-rule", "soft-rule", "both-rule", "wild-rule"];
		fixture(root, ".github/workflows/custom.yml", workflow(ids.map((id) => `${id}-marker`)));
		const findings = scanCIFilesForRecurrences(root);
		expect(findings.map((finding) => finding.check_id)).toEqual(ids);
		expect(findings.map((finding) => finding.text)).toEqual(ids.map((id) => `${id}-marker`));
	});

	// test-contract: boundary — CI classification is restricted to workflow YAML, Dockerfile variants, and Makefiles, while ignored trees never enter the recursive walk.
	it("selects CI file names and skips protected directory subtrees", () => {
		const root = sandbox();
		fixture(root, ".github/workflows/a.yaml", workflow(["rm -rf /"]));
		fixture(root, ".github/workflows/b.yml", workflow(["git reset --hard"]));
		fixture(root, "Dockerfile", "RUN rm -rf /etc\n");
		fixture(root, "app.Dockerfile", "RUN git clean -df\n");
		fixture(root, "Dockerfile.prod", "RUN git branch -D old\n");
		fixture(root, "Makefile", "wipe:\n\trm -rf /\n");
		fixture(root, "build.mk", "wipe:\n\tgit reset --hard\n");
		fixture(root, "docker-compose.yml", "command: rm -rf /\n");
		for (const directory of ["node_modules", "dist", "build", "vendor", ".next", ".git", ".interlinked", "coverage"]) {
			fixture(root, `${directory}/ignored.yml`, workflow(["rm -rf /"]));
		}
		const files = new Set(scanCIFilesForRecurrences(root).map((finding) => finding.file));
		expect(files).toEqual(
			new Set([
				".github/workflows/a.yaml",
				".github/workflows/b.yml",
				"Dockerfile",
				"app.Dockerfile",
				"Dockerfile.prod",
				"Makefile",
				"build.mk",
			]),
		);
	});

	// test-contract: public-api — source scanning honors caller roots/extensions and aggregates source plus CI findings without scanning unrelated extensions.
	it("aggregates source and CI findings with explicit scope", () => {
		const root = sandbox();
		fixture(root, "lib/unsafe.ts", "export const x = eval('1');\n");
		fixture(root, "src/unsafe.js", "export const x = eval('2');\n");
		fixture(root, "src/ignored.txt", "eval('3');\n");
		fixture(root, ".github/workflows/ci.yml", workflow(["rm -rf /"]));
		const findings = scanCodebaseForRecurrences({ cwd: root, roots: ["lib", "src"] });
		expect(findings.some((finding) => finding.file === "lib/unsafe.ts" && finding.check_id === "eval_usage")).toBe(true);
		expect(findings.some((finding) => finding.file === "src/unsafe.js" && finding.check_id === "eval_usage")).toBe(true);
		expect(findings.some((finding) => finding.file === ".github/workflows/ci.yml")).toBe(true);
		expect(findings.some((finding) => finding.file === "src/ignored.txt")).toBe(false);
	});

	// test-contract: boundary — a detector failure and an unreadable input are isolated so later files still contribute findings.
	it("skips malformed detector inputs and aggregates the remaining files", () => {
		const seen: string[] = [];
		const findings = scanFilesForDetector({
			files: ["missing.ts", "bad.ts", "good.ts"],
			readFile: (file) => {
				if (file === "missing.ts") throw new Error("unreadable");
				return file;
			},
			detector: (file, content) => {
				seen.push(file);
				if (file === "bad.ts") throw "malformed detector entry";
				return [{ check_id: "marker", file, line: 1, message: content }];
			},
		});
		expect(seen).toEqual(["bad.ts", "good.ts"]);
		expect(findings).toEqual([{ check_id: "marker", file: "good.ts", line: 1, message: "good.ts" }]);
	});
});
