import { describe, expect, it } from "vitest";
import { checkTaintedToPrivilegedSink } from "./tainted-sink.js";

const TS = "src/handlers/admin.ts";

describe("checkTaintedToPrivilegedSink — positive cases", () => {
	it("flags eval(req.body.code) — direct external input to eval", () => {
		const code = [
			"function handler(req: any) {",
			"  return eval(req.body.code);",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags child_process.exec(req.params.cmd) — direct exec of external input", () => {
		const code = [
			'import * as cp from "child_process";',
			"function handler(req: any) {",
			"  cp.exec(req.params.cmd);",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags new Function(req.query.fn) — dynamic function from external", () => {
		const code = [
			"function handler(req: any) {",
			"  const f = new Function(req.query.fn);",
			"  return f();",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags two-step: const cmd = req.body.cmd; exec(cmd);", () => {
		const code = [
			'import { exec } from "child_process";',
			"function handler(req: any) {",
			"  const cmd = req.body.cmd;",
			"  exec(cmd);",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags fs.writeFileSync with external-controlled path", () => {
		const code = [
			'import * as fs from "node:fs";',
			"function handler(req: any) {",
			"  fs.writeFileSync(req.body.path, 'data');",
			"}",
		].join("\n");
		const out = checkTaintedToPrivilegedSink(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkTaintedToPrivilegedSink — negative cases (must NOT fire)", () => {
	it("ignores hardcoded sink arguments", () => {
		const code = [
			"function ok() {",
			'  return eval("1 + 1");',
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});

	it("ignores when value passes through a known schema validator", () => {
		const code = [
			'import { z } from "zod";',
			"const Cmd = z.string();",
			'import { exec } from "child_process";',
			"function ok(req: any) {",
			"  const cmd = Cmd.parse(req.body.cmd);",
			"  exec(cmd);",
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});

	it("ignores non-sink uses of external input", () => {
		const code = [
			"function ok(req: any) {",
			"  console.log(req.body.foo);",
			"  return { echoed: req.body.foo };",
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});

	it("ignores process.env reads for control flow (no sink)", () => {
		const code = [
			"function ok() {",
			'  if (process.env.NODE_ENV === "test") return;',
			"  return loadProd();",
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});

	it("ignores typeof / Array.isArray / instanceof guard before sink", () => {
		const code = [
			'import { exec } from "child_process";',
			"const allowList = new Set(['ls', 'pwd']);",
			"function ok(req: any) {",
			"  const cmd = req.body.cmd;",
			"  if (typeof cmd !== 'string' || !allowList.has(cmd)) return;",
			"  exec(cmd);",
			"}",
		].join("\n");
		expect(checkTaintedToPrivilegedSink(code, TS)).toEqual([]);
	});
});
