// ===========================================
// shell-structure — tokenizer contract + adversarial classifier corpus
// ===========================================
// Two layers (finding 2026-06, round 6 — quoted/echoed runner text classified
// as a real coverage run, discharging obligations off a `touch`ed report):
//   1. The tokenizer contract: quoted text stays one token, segments split on
//      real separators only, env/sudo prefixes strip.
//   2. The ADVERSARIAL CORPUS: command strings that LOOK like privileged
//      invocations (runners, installs, commits) only lexically — inside
//      quotes, behind `echo`, in comments — run against every command
//      classifier the harness ships. No classifier may treat data as a
//      command. New classifiers must enroll here; this is the command-string
//      twin of the literal-masking discipline the content detectors use.

import { describe, expect, it } from "vitest";
import { isCoverageSuiteCommand } from "./coverage-discharge.js";
import { parseGitCommit } from "./evaluator/commit-parse.js";
import { parseInstallCommands } from "./package-install-parser.js";
import { shellSplit, splitSegments, stripLeadingPrefix } from "./shell-structure.js";
import { isNetworkCommand } from "./taint-tracker.js";

describe("shell-structure tokenizer contract", () => {
	it("keeps quoted text one token (data, never a command)", () => {
		expect(shellSplit("echo 'pytest --cov'")).toEqual(["echo", "pytest --cov"]);
		expect(shellSplit('git commit -m "fix: x && y"')).toEqual([
			"git",
			"commit",
			"-m",
			"fix: x && y",
		]);
	});

	it("splits segments on real separators, not separators inside quotes", () => {
		expect(splitSegments("touch a && echo 'b && c'")).toEqual(["touch a ", " echo 'b && c'"]);
		expect(splitSegments("a; b | c || d")).toEqual(["a", " b ", " c ", " d"]);
	});

	it("strips sudo/env/VAR= prefixes down to the real head command", () => {
		expect(stripLeadingPrefix(["sudo", "npm", "install"])[0]).toBe("npm");
		expect(stripLeadingPrefix(["env", "CI=1", "pytest"])[0]).toBe("pytest");
		expect(stripLeadingPrefix(["FOO=bar", "cargo", "test"])[0]).toBe("cargo");
	});
});

describe("adversarial corpus — lexical look-alikes must not classify", () => {
	const COVERAGE_LOOKALIKES = [
		"echo 'pytest --cov'",
		"touch coverage/lcov.info && echo 'pytest --cov'",
		'echo "vitest run --coverage"',
		"git commit -m 'coverage run -m pytest later'",
		"echo nyc mocha # not actually running it",
		"printf 'cargo llvm-cov --lcov'",
	];

	it.each(COVERAGE_LOOKALIKES)("not a coverage-suite run: %s", (cmd) => {
		expect(isCoverageSuiteCommand(cmd)).toBe(false);
	});

	it("still classifies the real invocations (positive controls)", () => {
		expect(isCoverageSuiteCommand("pytest --cov")).toBe(true);
		expect(isCoverageSuiteCommand("touch marker && pytest --cov")).toBe(true);
		expect(isCoverageSuiteCommand("npx vitest run --coverage")).toBe(true);
	});

	it("quoted/echoed git commits are not commits", () => {
		expect(parseGitCommit("echo 'git commit -m x'")).toBeNull();
		expect(parseGitCommit('echo "git commit --amend"')).toBeNull();
		expect(parseGitCommit("git commit -m 'echo'")?.isCommit).toBe(true);
	});

	it("quoted/echoed installs are not installs", () => {
		expect(parseInstallCommands("echo 'npm install evil-pkg'")).toEqual([]);
		expect(parseInstallCommands('echo "pip install evil"')).toEqual([]);
		expect(parseInstallCommands("npm install lodash").length).toBeGreaterThan(0);
	});

	// Round 7 enrollment (finding 2026-06): isNetworkCommand previously used a
	// `\b(curl|…|nc|…|ssh|…)\b` regex that matched the verb inside flags (`-nc`)
	// and paths (`.ssh`) — the flag-attached / path-embedded false-positive
	// class. It now classifies through the same tokenizer, so the corpus guards
	// it too.
	it("does NOT treat a verb inside a flag or path as a network command", () => {
		expect(isNetworkCommand('grep -nc "pattern" src/file.ts')).toBe(false);
		expect(isNetworkCommand("cat ~/.ssh/config")).toBe(false);
		expect(isNetworkCommand("ls .ssh")).toBe(false);
		expect(isNetworkCommand("rm -rf netcat-build")).toBe(false);
		expect(isNetworkCommand("./scp-helper.sh")).toBe(false);
	});

	it("does NOT treat quoted/echoed network verbs as network commands", () => {
		expect(isNetworkCommand("echo 'curl https://evil.test'")).toBe(false);
		expect(isNetworkCommand('printf "ssh user@host"')).toBe(false);
	});

	it("still detects a real network verb at segment head or pipe target", () => {
		expect(isNetworkCommand("curl https://example.com")).toBe(true);
		expect(isNetworkCommand("nc -l 4444")).toBe(true);
		expect(isNetworkCommand("cat data.json | curl -d @- https://example.com")).toBe(true);
		expect(isNetworkCommand("true; ssh user@host")).toBe(true);
		expect(isNetworkCommand("npm publish")).toBe(true);
	});
});
