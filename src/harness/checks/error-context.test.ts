import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	detectCatchRewrapLosesCause,
	detectJsonStringifyError,
	detectResourceHandleLeak,
} from "./error-context.js";

const FILE = "src/lib/service.ts";

// ═════════════════════════════════════════════════════════════════════════════
// json_stringify_error
// ═════════════════════════════════════════════════════════════════════════════

describe("detectJsonStringifyError — positive cases (must fire)", () => {
	it("fires on JSON.stringify(err) inside a catch block", () => {
		const content = `
try {
  run();
} catch (err) {
  logger.error(JSON.stringify(err));
}
`.trim();
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/json_stringify_error/);
		expect(nonNull(findings[0]).line).toBe(4);
	});

	it("fires when the binding is passed bare with replacer/space args", () => {
		const content = `
try {
  run();
} catch (e) {
  res.end(JSON.stringify(e, null, 2));
}
`.trim();
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/JSON\.stringify\(e\)/);
	});

	it("fires on a typed catch binding embedded in a template literal", () => {
		const content = `
async function save(): Promise<void> {
  try {
    await write();
  } catch (error: unknown) {
    console.log(\`failed: \${JSON.stringify(error)}\`);
  }
}
`.trim();
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(1);
	});
});

describe("detectJsonStringifyError — negative cases (must NOT fire)", () => {
	it("does not fire on JSON.stringify(err.message)", () => {
		const content = `
try {
  run();
} catch (err) {
  logger.error(JSON.stringify(err.message));
}
`.trim();
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("does not fire on an explicit-fields object literal", () => {
		const content = `
try {
  run();
} catch (err) {
  logger.error(JSON.stringify({ message: err.message, stack: err.stack }));
}
`.trim();
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("does not fire on JSON.stringify of a non-binding value in the catch", () => {
		const content = `
try {
  run();
} catch (err) {
  logger.error(err);
  audit(JSON.stringify(payload));
}
`.trim();
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("does not fire on JSON.stringify(data) outside any catch block", () => {
		const content = `
function persist(data: unknown): string {
  return JSON.stringify(data);
}
`.trim();
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("does not fire in test files", () => {
		const content = `
try {
  run();
} catch (err) {
  console.log(JSON.stringify(err));
}
`.trim();
		expect(detectJsonStringifyError(content, "src/lib/service.test.ts")).toEqual([]);
	});

	it("finds no catch blocks (and no findings) when the catch is never closed", () => {
		const content = `
try {
  run();
} catch (err) {
  logger.error(JSON.stringify(err));
`.trim();
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("dedupes two findings on the same line to one", () => {
		const content = `
try {
  run();
} catch (err) {
  logger.error(JSON.stringify(err)); other(JSON.stringify(err));
}
`.trim();
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(1);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) across many catch blocks", () => {
		const blocks = Array.from(
			{ length: 12 },
			(_, i) => `try {\n  run${i}();\n} catch (err) {\n  logger.error(JSON.stringify(err));\n}`,
		).join("\n");
		const findings = detectJsonStringifyError(blocks, FILE);
		expect(findings.length).toBe(10);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) within a SINGLE catch block (11 distinct lines)", () => {
		// Forces recordMatch's own cap check (not the outer per-block break) to
		// fire, since all hits land inside one catch body's inner while loop.
		const stmts = Array.from(
			{ length: 11 },
			(_, i) => `  logger.error(JSON.stringify(err)); // line ${i}`,
		).join("\n");
		const content = `try {\n  run();\n} catch (err) {\n${stmts}\n}`;
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(10);
	});

	it("does not fire on a non-JS/TS file extension", () => {
		const content = `
try {
  run();
} catch (err) {
  logger.error(JSON.stringify(err));
}
`.trim();
		expect(detectJsonStringifyError(content, "docs/notes.md")).toEqual([]);
	});

	it("handles a backslash escape followed by a non-newline char inside a quoted string", () => {
		const content = 'const s = "line1\\tline2";\ntry {\n  run();\n} catch (err) {\n  cleanup();\n}\n';
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("bails at line-end for a quote left open before a literal newline (no trailing backslash)", () => {
		const content =
			'const bad = "unterminated;\ntry {\n  run();\n} catch (err) {\n  logger.error(JSON.stringify(err));\n}\n';
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(1);
	});

	it("handles a backslash escape followed by a non-newline char inside a template literal", () => {
		const content = "const t = `line1\\tline2`;\ntry {\n  run();\n} catch (err) {\n  cleanup();\n}\n";
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("handles a template literal that is unterminated and ends the file mid-backtick", () => {
		const content = "const t = `unterminated";
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("preserves an unescaped newline inside a multi-line template literal", () => {
		const content =
			"const t = `line one\nline two`;\ntry {\n  run();\n} catch (err) {\n  logger.error(JSON.stringify(err));\n}\n";
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(1);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// catch_rewrap_loses_cause
// ═════════════════════════════════════════════════════════════════════════════

describe("detectCatchRewrapLosesCause — positive cases (must fire)", () => {
	it("fires on throw new Error with string concat of the binding", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error("failed: " + err);
}
`.trim();
		const findings = detectCatchRewrapLosesCause(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/catch_rewrap_loses_cause/);
		expect(nonNull(findings[0]).line).toBe(4);
	});

	it("fires on a template-interpolated binding in an Error subclass", () => {
		const content = `
try {
  run();
} catch (e) {
  throw new TypeError(\`bad input: \${e}\`);
}
`.trim();
		const findings = detectCatchRewrapLosesCause(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/TypeError/);
	});

	it("fires on a non-thrown construct using String(err)", () => {
		const content = `
try {
  run();
} catch (err) {
  const wrapped = new Error("context: " + String(err));
  report(wrapped);
}
`.trim();
		const findings = detectCatchRewrapLosesCause(content, FILE);
		expect(findings.length).toBe(1);
	});

	it("fires when only err.message is concatenated into the wrapper", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new HttpError("upstream: " + err.message);
}
`.trim();
		const findings = detectCatchRewrapLosesCause(content, FILE);
		expect(findings.length).toBe(1);
	});

	it("fires on a bare .toString() coercion of the binding (no concat)", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error(err.toString());
}
`.trim();
		const findings = detectCatchRewrapLosesCause(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/catch_rewrap_loses_cause/);
	});

	it("fires on a bare property read into the wrapper (new Error(err.message), no cause)", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error(err.message);
}
`.trim();
		const findings = detectCatchRewrapLosesCause(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/catch_rewrap_loses_cause/);
	});
});

describe("detectCatchRewrapLosesCause — negative cases (must NOT fire)", () => {
	it("does not fire on a plain rethrow of the same binding", () => {
		const content = `
try {
  run();
} catch (err) {
  cleanup();
  throw err;
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("does not fire on new Error(msg, { cause: err })", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error("failed to sync", { cause: err });
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("does not fire on an error class taking err as a constructor arg", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new WrapError(err);
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("does not fire when a template mentions err but cause is also passed", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error(\`failed: \${err}\`, { cause: err });
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("does not fire when the new Error never references the binding (lossy_error_rethrow's slice)", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error("operation failed");
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("does not fire on the error-normalization ternary (err instanceof Error ? err : new Error(String(err)))", () => {
		const content = `
try {
  run();
} catch (err) {
  return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("does not fire when 'err' only appears inside a plain string literal", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error("the err field was rejected", { cause: err });
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("does not fire on new Error(err.message, { cause: err }) — property read but cause preserved", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error(err.message, { cause: err });
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("does not fire when the catch is never closed (unbalanced braces, no catch block found)", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error("failed: " + err);
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("moves past a constructor call whose args are never closed (unmatched paren)", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error("bad: " + err;
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) across many catch blocks", () => {
		const blocks = Array.from(
			{ length: 12 },
			(_, i) => `try {\n  run${i}();\n} catch (err) {\n  throw new Error("failed: " + err);\n}`,
		).join("\n");
		const findings = detectCatchRewrapLosesCause(blocks, FILE);
		expect(findings.length).toBe(10);
	});

	// Internal string/template blanking helpers (shared by every detector in
	// this file, via prepareJsTsSource) — exercised through the public API
	// with content that doesn't itself produce a finding.
	it("handles a backslash line-continuation inside a quoted string literal", () => {
		const content = 'const a = "abc\\\ndef";\ntry {\n  run();\n} catch (err) {\n  cleanup();\n}\n';
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("handles a backslash line-continuation inside a template literal", () => {
		const content = "const t = `abc\\\ndef`;\ntry {\n  run();\n} catch (err) {\n  cleanup();\n}\n";
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("handles a nested template literal inside a ${} interpolation", () => {
		const content = "const b = `outer ${`inner`} tail`;\ntry {\n  run();\n} catch (err) {\n  cleanup();\n}\n";
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("handles brace-depth tracking for an object literal inside a ${} interpolation", () => {
		const content =
			"const c = `outer ${ {a:1}.a } tail`;\ntry {\n  run();\n} catch (err) {\n  cleanup();\n}\n";
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("handles a quoted literal that is unterminated and ends the file on a trailing backslash", () => {
		const content = 'const bad = "unterminated\\';
		expect(detectCatchRewrapLosesCause(content, FILE)).toEqual([]);
	});

	it("does not fire in test files", () => {
		const content = `
try {
  run();
} catch (err) {
  throw new Error("failed: " + err);
}
`.trim();
		expect(detectCatchRewrapLosesCause(content, "src/lib/service.test.ts")).toEqual([]);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// resource_handle_leak
// ═════════════════════════════════════════════════════════════════════════════

describe("detectResourceHandleLeak — positive cases (must fire)", () => {
	it("fires on fs.openSync with an early throw and no close anywhere", () => {
		const content = `
import fs from "node:fs";

function readHeader(path: string): Buffer {
  const fd = fs.openSync(path, "r");
  const buf = Buffer.alloc(16);
  const n = fs.readSync(fd, buf, 0, 16, 0);
  if (n < 16) throw new Error("short read");
  process(buf);
  done();
}
`.trim();
		const findings = detectResourceHandleLeak(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/resource_handle_leak/);
		expect(nonNull(findings[0]).text).toMatch(/\bfd\b/);
	});

	it("fires on fs.createWriteStream that is written to but never ended", () => {
		const content = `
import fs from "node:fs";

function log(path: string, msg: string): void {
  const ws = fs.createWriteStream(path, { flags: "a" });
  ws.write(msg);
}
`.trim();
		const findings = detectResourceHandleLeak(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/createWriteStream/);
	});

	it("fires on a bare openSync import from node:fs", () => {
		const content = `
import { openSync, readSync } from "node:fs";

function probe(path: string): number {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(4);
  readSync(fd, buf, 0, 4, 0);
  return buf.readUInt32LE(0);
}
`.trim();
		const findings = detectResourceHandleLeak(content, FILE);
		expect(findings.length).toBe(1);
	});
});

describe("detectResourceHandleLeak — negative cases (must NOT fire)", () => {
	it("does not fire when the fd is closed in a finally block", () => {
		const content = `
import fs from "node:fs";

function readHeader(path: string): Buffer {
  const fd = fs.openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}
`.trim();
		expect(detectResourceHandleLeak(content, FILE)).toEqual([]);
	});

	it("does not fire when the write stream is ended", () => {
		const content = `
import fs from "node:fs";

function log(path: string, msg: string): void {
  const ws = fs.createWriteStream(path, { flags: "a" });
  ws.write(msg);
  ws.end();
}
`.trim();
		expect(detectResourceHandleLeak(content, FILE)).toEqual([]);
	});

	it("does not fire when the handle is returned to the caller", () => {
		const content = `
import fs from "node:fs";

function openLog(path: string) {
  const ws = fs.createWriteStream(path, { flags: "a" });
  return ws;
}
`.trim();
		expect(detectResourceHandleLeak(content, FILE)).toEqual([]);
	});

	it("does not fire when the stream is a pipe target", () => {
		const content = `
import fs from "node:fs";

function copy(src: NodeJS.ReadableStream, dest: string): void {
  const ws = fs.createWriteStream(dest);
  src.pipe(ws);
}
`.trim();
		expect(detectResourceHandleLeak(content, FILE)).toEqual([]);
	});

	it("does not fire on a bare openSync call when node:fs is not imported", () => {
		const content = `
import { openSync } from "./my-pool.js";

function acquire(name: string): number {
  const handle = openSync(name);
  use(handle);
  return 0;
}
`.trim();
		expect(detectResourceHandleLeak(content, FILE)).toEqual([]);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) across many unreleased handles", () => {
		const body = Array.from(
			{ length: 12 },
			(_, i) => `function f${i}(path) {\n  const fd${i} = fs.openSync(path, "r");\n  use(fd${i});\n}`,
		).join("\n");
		const content = `import fs from "node:fs";\n${body}`;
		const findings = detectResourceHandleLeak(content, FILE);
		expect(findings.length).toBe(10);
	});

	it("does not fire on a non-JS/TS file extension", () => {
		const content = `
import fs from "node:fs";
function log(path) {
  const ws = fs.createWriteStream(path);
  ws.write("x");
}
`.trim();
		expect(detectResourceHandleLeak(content, "docs/notes.md")).toEqual([]);
	});

	it("does not fire when the handle is stored on the instance", () => {
		const content = `
import fs from "node:fs";

class Sink {
  private ws: fs.WriteStream | null = null;
  open(path: string): void {
    const ws = fs.createWriteStream(path);
    this.ws = ws;
  }
}
`.trim();
		expect(detectResourceHandleLeak(content, FILE)).toEqual([]);
	});
});
