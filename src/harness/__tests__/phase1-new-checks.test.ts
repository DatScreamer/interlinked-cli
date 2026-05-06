// Phase 1 of the agent-quality rollout — tests for the four net-new
// pre_block error checks (`child_process_exec_user_input`,
// `mixed_sync_async_file_api`, `cookie_missing_security_flags`,
// `logger_format_user_input`). Each detector requires ≥3 positive and
// ≥3 negative cases per the plan's FP-rate discipline.

import { describe, expect, it } from "vitest";
import {
	checkChildProcessExecUserInput,
	checkCookieMissingSecurityFlags,
	checkLoggerFormatUserInput,
	checkMixedSyncAsyncFileApi,
} from "../checks/ubs-language-specific.js";

describe("checkChildProcessExecUserInput", () => {
	it("flags `child_process.exec(userInput)`", () => {
		const code =
			"import child_process from 'child_process';\n" +
			"function run(userInput) { child_process.exec(userInput); }\n";
		expect(checkChildProcessExecUserInput(code, "src/run.ts").length).toBeGreaterThan(0);
	});

	it("flags `cp.execSync(req.body)` (aliased import)", () => {
		const code =
			"import cp from 'child_process';\n" +
			"function h(req) { cp.execSync(req); }\n";
		expect(checkChildProcessExecUserInput(code, "src/run.ts").length).toBeGreaterThan(0);
	});

	it("flags `childProcess.spawn(input, args)`", () => {
		const code =
			"import * as childProcess from 'child_process';\n" +
			"function s(input) { childProcess.spawn(input); }\n";
		expect(checkChildProcessExecUserInput(code, "src/run.ts").length).toBeGreaterThan(0);
	});

	it("flags interpolated template-literal commands", () => {
		const code =
			"import child_process from 'child_process';\n" +
			"function run(req) { child_process.exec(`git ${req.query.arg}`); }\n";
		expect(checkChildProcessExecUserInput(code, "src/run.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire on `child_process.exec(\"hardcoded string\")`", () => {
		const code = "child_process.exec('git status');";
		expect(checkChildProcessExecUserInput(code, "src/run.ts")).toEqual([]);
	});

	it("does NOT fire on `child_process.exec(`template${literal}`)` template literal", () => {
		const code = "child_process.exec(`echo hi`);";
		expect(checkChildProcessExecUserInput(code, "src/run.ts")).toEqual([]);
	});

	it("does NOT fire on regex `re.exec(input)`", () => {
		const code = "const m = /abc/.exec(input);";
		expect(checkChildProcessExecUserInput(code, "src/run.ts")).toEqual([]);
	});

	it("does NOT fire on test files", () => {
		const code = "child_process.exec(payload);";
		expect(checkChildProcessExecUserInput(code, "src/foo.test.ts")).toEqual([]);
	});

	it("does NOT fire on Python files (cross-language gate)", () => {
		const code = "child_process.exec(payload);";
		expect(checkChildProcessExecUserInput(code, "src/run.py")).toEqual([]);
	});
});

describe("checkMixedSyncAsyncFileApi", () => {
	it("flags a function with both readFileSync and await readFile", () => {
		const code =
			"import * as fs from 'node:fs';\n" +
			"async function load(p) {\n" +
			"  const meta = fs.readFileSync(p + '.meta');\n" +
			"  const body = await fs.readFile(p);\n" +
			"  return { meta, body };\n" +
			"}\n";
		expect(checkMixedSyncAsyncFileApi(code, "src/loader.ts").length).toBeGreaterThan(0);
	});

	it("flags writeFileSync next to await writeFile", () => {
		const code =
			"import * as fs from 'node:fs';\n" +
			"async function save(p, x) {\n" +
			"  fs.writeFileSync(p + '.bak', x);\n" +
			"  await fs.writeFile(p, x);\n" +
			"}\n";
		expect(checkMixedSyncAsyncFileApi(code, "src/saver.ts").length).toBeGreaterThan(0);
	});

	it("flags fsp.readdir with fs.statSync", () => {
		const code =
			"import * as fs from 'node:fs';\n" +
			"import * as fsp from 'node:fs/promises';\n" +
			"async function list(d) {\n" +
			"  const entries = await fsp.readdir(d);\n" +
			"  for (const e of entries) fs.statSync(e);\n" +
			"}\n";
		expect(checkMixedSyncAsyncFileApi(code, "src/lister.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire on a fully-async function", () => {
		const code =
			"import * as fs from 'node:fs/promises';\n" +
			"async function load(p) { return await fs.readFile(p); }\n";
		expect(checkMixedSyncAsyncFileApi(code, "src/loader.ts")).toEqual([]);
	});

	it("does NOT fire on a fully-sync function", () => {
		const code =
			"import * as fs from 'node:fs';\n" +
			"function load(p) {\n" +
			"  const meta = fs.readFileSync(p + '.meta');\n" +
			"  const body = fs.readFileSync(p);\n" +
			"  return { meta, body };\n" +
			"}\n";
		expect(checkMixedSyncAsyncFileApi(code, "src/loader.ts")).toEqual([]);
	});

	it("does NOT fire on test files", () => {
		const code =
			"import * as fs from 'node:fs';\n" +
			"async function f() { fs.readFileSync('a'); await fs.readFile('b'); }\n";
		expect(checkMixedSyncAsyncFileApi(code, "src/foo.test.ts")).toEqual([]);
	});

	// Regression: pre_block FP. Two adjacent helper functions, one fully-sync
	// and one fully-async, must NOT cross-fire because the sliding window
	// happened to span both. Each function in isolation is consistent.
	it("does NOT fire when sync and async live in two separate sibling functions", () => {
		const code =
			"import * as fs from 'node:fs';\n" +
			"import * as fsp from 'node:fs/promises';\n" +
			"function readSettings(p) {\n" +
			"  return fs.readFileSync(p, 'utf-8');\n" +
			"}\n" +
			"\n" +
			"async function readPayload(p) {\n" +
			"  return await fsp.readFile(p, 'utf-8');\n" +
			"}\n";
		expect(checkMixedSyncAsyncFileApi(code, "src/dual.ts")).toEqual([]);
	});

	it("does NOT cross-fire across class methods", () => {
		const code =
			"import * as fs from 'node:fs';\n" +
			"import * as fsp from 'node:fs/promises';\n" +
			"class Loader {\n" +
			"  loadSync(p) { return fs.readFileSync(p); }\n" +
			"  async loadAsync(p) { return await fsp.readFile(p); }\n" +
			"}\n";
		expect(checkMixedSyncAsyncFileApi(code, "src/loader.ts")).toEqual([]);
	});
});

describe("checkCookieMissingSecurityFlags", () => {
	it("flags res.cookie with neither flag", () => {
		const code = "res.cookie('sid', token, { maxAge: 1000 });";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts").length).toBeGreaterThan(0);
	});

	it("flags res.cookie with only httpOnly", () => {
		const code = "res.cookie('sid', token, { httpOnly: true });";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts").length).toBeGreaterThan(0);
	});

	it("flags cookies.set without secure", () => {
		const code = "cookies.set('sid', token, { httpOnly: true, sameSite: 'lax' });";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts").length).toBeGreaterThan(0);
	});

	it("flags res.cookie without an options object", () => {
		const code = "res.cookie('sid', token);";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts").length).toBeGreaterThan(0);
	});

	it("flags cookies.set without an options object", () => {
		const code = "cookies.set('sid', token);";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts").length).toBeGreaterThan(0);
	});

	it("flags Set-Cookie headers without security attributes", () => {
		const code = "res.setHeader('Set-Cookie', `sid=${token}`);";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when both httpOnly and secure are set", () => {
		const code = "res.cookie('sid', token, { httpOnly: true, secure: true });";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts")).toEqual([]);
	});

	it("does NOT fire on Set-Cookie headers with HttpOnly and Secure", () => {
		const code = "res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Secure; SameSite=Lax`);";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts")).toEqual([]);
	});

	it("does NOT fire on test files", () => {
		const code = "res.cookie('sid', token, { });";
		expect(checkCookieMissingSecurityFlags(code, "src/h.test.ts")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		const code = "res.cookie('sid', token, { });";
		expect(checkCookieMissingSecurityFlags(code, "src/h.py")).toEqual([]);
	});

	// Regression: pre_block FP. The previous regex stopped at the first `)`
	// in the call, so options that contained nested calls (e.g.
	// `expires: new Date(...)`) were truncated before httpOnly/secure could
	// be inspected — and the secure cookie was wrongly hard-blocked.
	it("does NOT fire when options object contains a nested call before the security flags", () => {
		const code =
			"res.cookie('sid', token, {\n" +
			"  expires: new Date(Date.now() + 3600_000),\n" +
			"  httpOnly: true,\n" +
			"  secure: true,\n" +
			"});";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts")).toEqual([]);
	});

	it("does NOT fire when cookies.set carries a computed maxAge before flags", () => {
		const code =
			"cookies.set('sid', token, {\n" +
			"  maxAge: ttlFor(req.user) * 1000,\n" +
			"  sameSite: pickSameSite(req),\n" +
			"  httpOnly: true,\n" +
			"  secure: true,\n" +
			"});";
		expect(checkCookieMissingSecurityFlags(code, "src/h.ts")).toEqual([]);
	});
});

describe("checkLoggerFormatUserInput", () => {
	it("flags logger.info(req)", () => {
		const code = "function h(req) { logger.info(req); }";
		expect(checkLoggerFormatUserInput(code, "src/h.ts").length).toBeGreaterThan(0);
	});

	it("flags logger.error(userInput)", () => {
		const code = "function h(userInput) { logger.error(userInput); }";
		expect(checkLoggerFormatUserInput(code, "src/h.ts").length).toBeGreaterThan(0);
	});

	it("flags log.warn(ctx) with custom prefix", () => {
		const code = "function h(ctx) { log.warn(ctx); }";
		expect(checkLoggerFormatUserInput(code, "src/h.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire on logger.info(\"static message\")", () => {
		const code = "logger.info('static message');";
		expect(checkLoggerFormatUserInput(code, "src/h.ts")).toEqual([]);
	});

	it("does NOT fire on logger.info(\"msg\", userInput) — userInput is structured arg, not format", () => {
		const code = "logger.info('msg', { userInput });";
		expect(checkLoggerFormatUserInput(code, "src/h.ts")).toEqual([]);
	});

	it("does NOT fire on test files", () => {
		const code = "logger.info(req);";
		expect(checkLoggerFormatUserInput(code, "src/h.test.ts")).toEqual([]);
	});
});
