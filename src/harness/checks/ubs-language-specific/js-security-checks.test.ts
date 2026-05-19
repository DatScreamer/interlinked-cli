// Smoke tests for the JS/TS-security UBS detectors. The exhaustive red/green
// suites live in src/harness/__tests__/ubs-*.test.ts and exercise these via
// the ubs-language-specific.ts barrel; this colocated file covers the module
// surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkChildProcessExecUserInput,
	checkCookieMissingSecurityFlags,
	checkEvalInputTainted,
	checkLoggerFormatUserInput,
	checkMixedSyncAsyncFileApi,
	checkUncheckedRedirect,
} from "./js-security-checks.js";

describe("ubs-language-specific/js-security-checks", () => {
	it("checkEvalInputTainted flags eval with an identifier arg", () => {
		expect(checkEvalInputTainted("eval(userCode)", "a.js").length).toBeGreaterThan(0);
		expect(checkEvalInputTainted('eval("1+1")', "a.js")).toEqual([]);
	});

	it("checkChildProcessExecUserInput flags namespaced exec with a var arg", () => {
		const code = "child_process.exec(userInput)";
		expect(checkChildProcessExecUserInput(code, "a.js").length).toBeGreaterThan(0);
	});

	it("checkMixedSyncAsyncFileApi flags a function mixing sync and async fs", () => {
		const code =
			"async function f() {\n  fs.readFileSync(p);\n  await fs.readFile(q);\n}";
		expect(checkMixedSyncAsyncFileApi(code, "a.js").length).toBeGreaterThan(0);
	});

	it("checkCookieMissingSecurityFlags flags res.cookie without flags", () => {
		expect(
			checkCookieMissingSecurityFlags('res.cookie("s", v)', "a.js").length,
		).toBeGreaterThan(0);
	});

	it("checkLoggerFormatUserInput flags logger.info with a request-bound arg", () => {
		expect(
			checkLoggerFormatUserInput("logger.info(req)", "a.js").length,
		).toBeGreaterThan(0);
	});

	it("checkUncheckedRedirect flags redirect with an identifier arg", () => {
		expect(checkUncheckedRedirect("redirect(url)", "a.js").length).toBeGreaterThan(0);
	});

	it("all checks return empty for non-JS/TS files", () => {
		expect(checkEvalInputTainted("eval(x)", "a.go")).toEqual([]);
		expect(checkUncheckedRedirect("redirect(x)", "a.go")).toEqual([]);
	});
});
