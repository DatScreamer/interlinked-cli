// ===========================================
// Poison-fixture corpus — no verifier may call broken code clean (round 6)
// ===========================================
// Every wrapped tool runner gets fed a deliberately-INVALID source sample; a
// runner that reports it clean is fail-open — a tool failure (parse error,
// bad flag, wrong edition) reading as a green pass. That is exactly how
// file-mode rustfmt silently skipped formatting validation for 2021/2024
// crates: the parse error produced no diff headers and the runner returned
// [], while the check still carried its [proven] tag. The corpus makes the
// fail-open class a write-time regression for every enrolled runner.
//
// Runners are exercised against the REAL tool when it is installed and
// visibly SKIPPED otherwise (it.skipIf — reported, never a silent early
// return; the test-portability rules apply to us first). Known fail-open
// runners belong in PINNED_FAIL_OPEN with a comment — the list may only
// shrink. New tool runners must enroll a poison sample here.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBiome } from "../tool-runners/biome.js";
import { runRuff } from "../tool-runners/python.js";
import { runRustfmtCheck } from "../tool-runners/rust.js";
import type { ToolRunnerInput } from "../types.js";

/** Runners whose fail-open behavior is KNOWN and tracked for ratcheting.
 *  Adding here requires a comment naming the failure mode; entries may only
 *  ever be removed. */
const PINNED_FAIL_OPEN = new Set<string>();

function toolAvailable(cmd: string, args: string[]): boolean {
	try {
		return spawnSync(cmd, args, { stdio: "ignore", timeout: 15_000 }).status === 0;
	} catch {
		return false;
	}
}

const rustfmtAvailable = toolAvailable("rustfmt", ["--version"]);
const ruffAvailable = toolAvailable("ruff", ["--version"]);
const biomeAvailable = toolAvailable("npx", ["biome", "--version"]);

let projectRoot: string;

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), "poison-corpus-"));
});

afterEach(() => {
	rmSync(projectRoot, { recursive: true, force: true });
});

function inputFor(targetFile: string): ToolRunnerInput {
	return {
		scope: { mode: "file", projectRoot, targetFile, filterToFile: false },
		timeoutMs: 30_000,
	};
}

function expectNotClean(tool: string, findings: unknown[]): void {
	if (PINNED_FAIL_OPEN.has(tool)) return; // tracked debt — may only shrink
	expect(findings.length, `${tool} reported the poison file CLEAN — fail-open verifier`).toBeGreaterThan(0);
}

describe("poison corpus — invalid sources must never pass", () => {
	it.skipIf(!rustfmtAvailable)(
		"rustfmt does not call an unparsable 2021-edition file clean",
		() => {
			mkdirSync(join(projectRoot, "src"), { recursive: true });
			writeFileSync(
				join(projectRoot, "Cargo.toml"),
				'[package]\nname = "poison"\nversion = "0.0.0"\nedition = "2021"\n',
				"utf-8",
			);
			// Unclosed paren + brace — unparsable in EVERY edition.
			writeFileSync(join(projectRoot, "src/poison.rs"), "fn main( {\n", "utf-8");
			const findings = runRustfmtCheck(inputFor("src/poison.rs"));
			expectNotClean("rustfmt", findings);
		},
		60_000,
	);

	it.skipIf(!ruffAvailable)(
		"ruff does not call a syntax-error Python file clean",
		() => {
			writeFileSync(join(projectRoot, "poison.py"), "def f(:\n    pass\n", "utf-8");
			const findings = runRuff(inputFor("poison.py"));
			expectNotClean("ruff", findings);
		},
		60_000,
	);

	it.skipIf(!biomeAvailable)(
		"biome does not call a syntax-error TypeScript file clean",
		() => {
			// Exercise the runner as deployed: a biome.json so the config gate
			// passes (an unconfigured project legitimately skips), and the repo's
			// node_modules linked so `npx biome` resolves locally and offline.
			writeFileSync(join(projectRoot, "biome.json"), "{}\n", "utf-8");
			symlinkSync(join(process.cwd(), "node_modules"), join(projectRoot, "node_modules"), "dir");
			writeFileSync(join(projectRoot, "poison.ts"), "const = {{{\n", "utf-8");
			const findings = runBiome(inputFor("poison.ts"));
			expectNotClean("biome", findings);
		},
		60_000,
	);
});
