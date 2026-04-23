// ===========================================
// Supply Chain Defense — Code Quality Checks
// ===========================================
// Split from supply-chain-defense.test.ts:
// - checkTyposquatDependencies
// - checkInfiniteRetryLoop
// - checkHardcodedLocalhost
// - checkProcessExitInLibrary
// - checkImportFromDist
// - checkPlaceholderValues
// - checkErrorMessageLeakage
// - PostToolUse typosquat warning

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePostToolUse } from "../evaluator.js";
import {
	checkErrorMessageLeakage,
	checkHardcodedLocalhost,
	checkImportFromDist,
	checkInfiniteRetryLoop,
	checkPlaceholderValues,
	checkProcessExitInLibrary,
	checkTyposquatDependencies,
} from "../generic-checks.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, SessionTrajectory } from "../types.js";
import { makeEvent, makeSession } from "./fixtures/supply-chain.js";

// ===========================================
// 7. Typosquat Detection
// ===========================================

describe("checkTyposquatDependencies", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("detects typosquatted express (expresss)", () => {
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({ dependencies: { expresss: "^4.18.0" } }),
		);
		const matches = checkTyposquatDependencies(join(tempDir, "package.json"));
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("expresss");
		expect(matches[0].text).toContain("express");
	});

	it("detects typosquatted lodash (lodashe)", () => {
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({ dependencies: { lodashe: "^4.0.0" } }),
		);
		const matches = checkTyposquatDependencies(join(tempDir, "package.json"));
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("lodash");
	});

	it("detects typosquatted axios (axois)", () => {
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({ dependencies: { axois: "^1.9.0" } }),
		);
		const matches = checkTyposquatDependencies(join(tempDir, "package.json"));
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("axios");
	});

	it("does NOT flag legitimate popular package names", () => {
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				dependencies: { express: "^4.0.0", lodash: "^4.0.0", axios: "^1.0.0" },
			}),
		);
		const matches = checkTyposquatDependencies(join(tempDir, "package.json"));
		expect(matches).toEqual([]);
	});

	it("does NOT flag unrelated package names", () => {
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				dependencies: { "my-custom-lib": "^1.0.0", "project-utils": "^2.0.0" },
			}),
		);
		const matches = checkTyposquatDependencies(join(tempDir, "package.json"));
		expect(matches).toEqual([]);
	});

	it("checks devDependencies too", () => {
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({ devDependencies: { typescirpt: "^5.0.0" } }),
		);
		const matches = checkTyposquatDependencies(join(tempDir, "package.json"));
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("typescript");
	});

	it("handles empty dependencies", () => {
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }));
		const matches = checkTyposquatDependencies(join(tempDir, "package.json"));
		expect(matches).toEqual([]);
	});
});

// ===========================================
// 8. Code Quality Generic Checks
// ===========================================

describe("checkInfiniteRetryLoop", () => {
	it("detects while(true) + catch + continue without backoff", () => {
		const code = `
async function poll() {
  while (true) {
    try {
      await fetch("/api");
    } catch (e) {
      continue;
    }
  }
}`;
		const matches = checkInfiniteRetryLoop(code, "src/poll.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag retry with backoff", () => {
		const code = `
async function poll() {
  while (true) {
    try {
      await fetch("/api");
    } catch (e) {
      await delay(1000);
      continue;
    }
  }
}`;
		const matches = checkInfiniteRetryLoop(code, "src/poll.ts");
		expect(matches).toEqual([]);
	});

	it("does NOT flag retry with retry counter", () => {
		const code = `
async function poll() {
  let retries = 0;
  while (true) {
    try {
      await fetch("/api");
    } catch (e) {
      retries++;
      continue;
    }
  }
}`;
		const matches = checkInfiniteRetryLoop(code, "src/poll.ts");
		expect(matches).toEqual([]);
	});

	it("skips test files", () => {
		const code = "while (true) { try { await x(); } catch { continue; } }";
		expect(checkInfiniteRetryLoop(code, "src/poll.test.ts")).toEqual([]);
	});
});

describe("checkHardcodedLocalhost", () => {
	it("detects hardcoded localhost URL in source", () => {
		const code = 'const API = "http://localhost:8787/api";\n';
		const matches = checkHardcodedLocalhost(code, "src/api.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag localhost behind env fallback", () => {
		const code = 'const API = process.env.API_URL ?? "http://localhost:8787";\n';
		expect(checkHardcodedLocalhost(code, "src/api.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = 'const API = "http://localhost:8787";\n';
		expect(checkHardcodedLocalhost(code, "src/api.test.ts")).toEqual([]);
	});

	it("does NOT flag CLI files", () => {
		const code = 'const API = "http://localhost:8787";\n';
		expect(checkHardcodedLocalhost(code, "src/commands/dev.ts")).toEqual([]);
	});
});

describe("checkProcessExitInLibrary", () => {
	it("detects process.exit() in library code", () => {
		const code = "function handleError(e: Error) {\n  process.exit(1);\n}\n";
		const matches = checkProcessExitInLibrary(code, "src/utils/handler.ts");
		expect(matches.length).toBe(1);
	});

	it("allows process.exit() in CLI entry point", () => {
		const code = "process.exit(1);\n";
		expect(checkProcessExitInLibrary(code, "src/commands/deploy.ts")).toEqual([]);
		expect(checkProcessExitInLibrary(code, "src/cli/main.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "process.exit(1);\n";
		expect(checkProcessExitInLibrary(code, "src/handler.test.ts")).toEqual([]);
	});
});

describe("checkImportFromDist", () => {
	it("detects import from dist/", () => {
		const code = 'import { foo } from "../dist/utils";\n';
		const matches = checkImportFromDist(code, "src/index.ts");
		expect(matches.length).toBe(1);
	});

	it("detects require from build/", () => {
		const code = 'const x = require("./build/lib");\n';
		const matches = checkImportFromDist(code, "src/index.ts");
		expect(matches.length).toBe(1);
	});

	it("does NOT flag normal imports", () => {
		const code = 'import { foo } from "../utils/bar";\n';
		expect(checkImportFromDist(code, "src/index.ts")).toEqual([]);
	});
});

describe("checkPlaceholderValues", () => {
	it("detects YOUR_API_KEY_HERE in .env", () => {
		const code = "API_KEY=YOUR_API_KEY_HERE\n";
		const matches = checkPlaceholderValues(code, ".env");
		expect(matches.length).toBe(1);
	});

	it("detects CHANGEME in config", () => {
		const code = 'secret: "CHANGEME"\n';
		const matches = checkPlaceholderValues(code, "config.yaml");
		expect(matches.length).toBe(1);
	});

	it("detects TODO_REPLACE in json config", () => {
		const code = '{"key": "TODO_REPLACE"}\n';
		const matches = checkPlaceholderValues(code, "settings.json");
		expect(matches.length).toBe(1);
	});

	it("does NOT flag .env.example files", () => {
		const code = "API_KEY=YOUR_API_KEY_HERE\n";
		expect(checkPlaceholderValues(code, ".env.example")).toEqual([]);
	});

	it("does NOT flag regular source files", () => {
		const code = 'const x = "YOUR_API_KEY_HERE";\n';
		expect(checkPlaceholderValues(code, "src/index.ts")).toEqual([]);
	});
});

describe("checkErrorMessageLeakage", () => {
	it("detects res.json with raw error message", () => {
		const code = "catch (err) { res.json({ error: err.message }); }\n";
		const matches = checkErrorMessageLeakage(code, "src/handler.ts");
		expect(matches.length).toBe(1);
	});

	it("detects res.send with error stack", () => {
		const code = "catch (e) { res.send(e.stack); }\n";
		const matches = checkErrorMessageLeakage(code, "src/handler.ts");
		expect(matches.length).toBe(1);
	});

	it("detects new Response with error", () => {
		const code = "catch (error) { return new Response(error.message, { status: 500 }); }\n";
		const matches = checkErrorMessageLeakage(code, "src/worker.ts");
		expect(matches.length).toBe(1);
	});

	it("does NOT flag error logging (console.error)", () => {
		const code = "catch (err) { console.error(err.message); }\n";
		expect(checkErrorMessageLeakage(code, "src/handler.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "catch (err) { res.json({ error: err.message }); }\n";
		expect(checkErrorMessageLeakage(code, "src/handler.test.ts")).toEqual([]);
	});
});

// ===========================================
// 9. PostToolUse typosquat wiring
// ===========================================

describe("PostToolUse typosquat warning", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;
	let tempDir: string;

	beforeEach(() => {
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
		tempDir = mkdtempSync(join(tmpdir(), "posttool-typosquat-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("emits supply-chain warning for typosquatted dependency", () => {
		const pkgPath = join(tempDir, "package.json");
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { expresss: "^4.18.0" } }));

		const event = makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Write",
			tool_input: { file_path: pkgPath },
		});
		const result = evaluatePostToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("allow");
		expect(
			result.warnings?.some((w) => w.includes("supply-chain") && w.includes("expresss")),
		).toBe(true);
	});
});
