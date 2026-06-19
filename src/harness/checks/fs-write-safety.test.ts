import { describe, expect, it } from "vitest";
import { detectWriteWithoutMkdir } from "./fs-write-safety.js";

const TS = "src/lib/foo.ts";
const JS = "src/lib/foo.js";
const PY = "src/lib/foo.py"; // non-JS/TS — should never fire

// ─── Positive cases (MUST fire) ──────────────────────────────────────────────

describe("detectWriteWithoutMkdir — positive cases", () => {
	it("flags writeFileSync with join(dir, sub, file) and no mkdir", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			"  writeFileSync(join(cwd, '.interlinked', 'metric-caps.json'), data);",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(4);
	});

	it("flags appendFileSync with join(a, logs, x.log) and no mkdir", () => {
		const code = [
			"import { appendFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function log(root: string, line: string) {",
			"  appendFileSync(join(root, 'logs', 'x.log'), line + '\\n');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(4);
	});

	it("flags fs.writeFile with join(root, .tool, c.json) and no mkdir", () => {
		const code = [
			"import * as fs from 'node:fs';",
			"import { join } from 'node:path';",
			"function writeConfig(root: string, data: string, cb: () => void) {",
			"  fs.writeFile(join(root, '.tool', 'c.json'), data, cb);",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(4);
	});

	it("flags createWriteStream with string literal containing /", () => {
		const code = [
			"import { createWriteStream } from 'node:fs';",
			"function openLog() {",
			"  const stream = createWriteStream('logs/output.log');",
			"  stream.write('hello');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, JS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(3);
	});

	it("flags writeFileSync with string literal path containing /", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"function init() {",
			"  writeFileSync('.interlinked/config.json', '{}');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(3);
	});
});

// ─── Negative cases (must NOT fire) ──────────────────────────────────────────

describe("detectWriteWithoutMkdir — negative cases (must NOT fire)", () => {
	it("does not fire when mkdirSync with recursive:true precedes the write", () => {
		const code = [
			"import { mkdirSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			"  mkdirSync(join(cwd, '.interlinked'), { recursive: true });",
			"  writeFileSync(join(cwd, '.interlinked', 'metric-caps.json'), data);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire when mkdir (async) with recursive precedes the write", () => {
		const code = [
			"import { mkdir, writeFile } from 'node:fs/promises';",
			"import { join } from 'node:path';",
			"async function save(root: string) {",
			"  await mkdir(join(root, 'out'), { recursive: true });",
			"  await writeFile(join(root, 'out', 'result.json'), content);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire for writeFileSync('flat.txt', x) — no directory part", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"function dump(x: string) {",
			"  writeFileSync('flat.txt', x);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire when path is an opaque variable (cannot resolve statically)", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"function dump(p: string, x: string) {",
			"  writeFileSync(p, x);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire for non-JS/TS file", () => {
		const code = [
			"with open('logs/output.log', 'w') as f:",
			"    f.write('hello')",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, PY)).toEqual([]);
	});

	it("does not fire when existsSync precedes the write", () => {
		const code = [
			"import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			"  if (!existsSync(join(cwd, 'out'))) {",
			"    mkdirSync(join(cwd, 'out'));",
			"  }",
			"  writeFileSync(join(cwd, 'out', 'result.json'), data);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire when join has only 1 argument (not a nested path)", () => {
		// join with a single arg is unusual but syntactically valid
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function dump(dir: string) {",
			"  writeFileSync(join(dir), 'data');",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});
});
