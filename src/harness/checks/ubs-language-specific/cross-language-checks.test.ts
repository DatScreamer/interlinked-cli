// Smoke tests for the cross-language UBS detectors. The exhaustive red/green
// suites live in src/harness/__tests__/ubs-sql-string-concat.test.ts and
// ubs-hardcoded-localhost.test.ts and exercise these via the
// ubs-language-specific.ts barrel; this colocated file covers the module
// surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkSqlEscapeHatchNonLiteral,
	checkSqlStringConcat,
	checkUbsHardcodedLocalhost,
} from "./cross-language-checks.js";

describe("ubs-language-specific/cross-language-checks", () => {
	describe("checkSqlStringConcat", () => {
		it("flags `\"SELECT ... FROM \" + table`", () => {
			const code = 'const q = "SELECT * FROM " + table;';
			expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("flags a template literal with interpolation", () => {
			const code = "const q = `SELECT * FROM users WHERE id = ${userId}`;";
			expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("does not flag a parameterized query (`$1` placeholder)", () => {
			const code = 'db.query("SELECT * FROM users WHERE id = $1", [id]);';
			expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
		});

		it("flags a Swift string with `\\(...)` interpolation around a SELECT", () => {
			const code = 'let q = "SELECT * FROM users WHERE id = \\(userId)"';
			expect(checkSqlStringConcat(code, "DB.swift").length).toBeGreaterThan(0);
		});

		it("does not flag a Swift parameterized query (`?` placeholder)", () => {
			const code = 'db.execute("SELECT * FROM users WHERE id = ?", arguments: [id])';
			expect(checkSqlStringConcat(code, "DB.swift")).toEqual([]);
		});
	});

	describe("checkUbsHardcodedLocalhost", () => {
		it("flags a hardcoded localhost URL in source", () => {
			const code = 'const api = "http://localhost:3000/api";';
			expect(checkUbsHardcodedLocalhost(code, "src/client.ts").length).toBeGreaterThan(0);
		});

		it("does not flag a fallback default after `||`", () => {
			const code = 'const url = process.env.URL || "http://localhost:8787";';
			expect(checkUbsHardcodedLocalhost(code, "src/client.ts")).toEqual([]);
		});

		it("does not flag non-source extensions", () => {
			expect(checkUbsHardcodedLocalhost("uses localhost here", "notes.md")).toEqual([]);
		});
	});

	describe("checkSqlEscapeHatchNonLiteral (Effect §2.6)", () => {
		it("flags `sql.unsafe(<identifier>)` (Effect SQL)", () => {
			const code = "const q = sql.unsafe(tableName);";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("flags `sql.raw(<identifier>)` (Drizzle)", () => {
			const code = "const q = sql.raw(userInput);";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("flags `sql.lit(<expression>)` (Kysely)", () => {
			const code = "const q = sql.lit(getName());";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("does NOT flag `sql.unsafe(\"<string literal>\")`", () => {
			const code = 'const q = sql.unsafe("public.users");';
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts")).toEqual([]);
		});

		it("does NOT flag `sql.raw('<single-quoted>')`", () => {
			const code = "const q = sql.raw('public');";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts")).toEqual([]);
		});

		it("does NOT flag `sql.unsafe(`<template literal>`)`", () => {
			const code = "const q = sql.unsafe(`public.users`);";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts")).toEqual([]);
		});

		it("skips test files entirely", () => {
			const code = "const q = sql.unsafe(tableName);";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.test.ts")).toEqual([]);
		});

		it("skips non-source files", () => {
			const code = "const q = sql.unsafe(tableName);";
			expect(checkSqlEscapeHatchNonLiteral(code, "notes.md")).toEqual([]);
		});
	});
});

describe("checkSqlStringConcat — extension coverage", () => {
	const concat = 'const q = "SELECT * FROM " + table;';

	it("flags .tsx", () => {
		expect(checkSqlStringConcat(concat, "Component.tsx").length).toBeGreaterThan(0);
	});
	it("flags .js", () => {
		expect(checkSqlStringConcat(concat, "db.js").length).toBeGreaterThan(0);
	});
	it("flags .jsx", () => {
		expect(checkSqlStringConcat(concat, "Component.jsx").length).toBeGreaterThan(0);
	});
	it("flags .mjs", () => {
		expect(checkSqlStringConcat(concat, "db.mjs").length).toBeGreaterThan(0);
	});
	it("flags .cjs", () => {
		expect(checkSqlStringConcat(concat, "db.cjs").length).toBeGreaterThan(0);
	});
	it("flags .py", () => {
		expect(checkSqlStringConcat(concat, "db.py").length).toBeGreaterThan(0);
	});
	it("flags .go", () => {
		expect(checkSqlStringConcat(concat, "db.go").length).toBeGreaterThan(0);
	});
	it("flags .rs", () => {
		expect(checkSqlStringConcat(concat, "db.rs").length).toBeGreaterThan(0);
	});
	it("does NOT flag an unsupported extension", () => {
		expect(checkSqlStringConcat(concat, "notes.txt")).toEqual([]);
	});
	it("skips test files", () => {
		expect(checkSqlStringConcat(concat, "db.test.ts")).toEqual([]);
	});
});

describe("checkSqlStringConcat — verb coverage", () => {
	it("flags SELECT DISTINCT ... FROM concatenation", () => {
		const code = 'const q = "SELECT DISTINCT " + col + " FROM users";';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags INSERT INTO concatenation", () => {
		const code = 'const q = "INSERT INTO users VALUES (" + values + ")";';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags UPDATE ... SET concatenation", () => {
		const code = 'const q = "UPDATE users SET name = " + name;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DELETE FROM concatenation", () => {
		const code = 'const q = "DELETE FROM users WHERE id = " + id;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP TABLE concatenation", () => {
		const code = 'const q = "DROP TABLE " + tableName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP INDEX concatenation", () => {
		const code = 'const q = "DROP INDEX " + idxName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP DATABASE concatenation", () => {
		const code = 'const q = "DROP DATABASE " + dbName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP SCHEMA concatenation", () => {
		const code = 'const q = "DROP SCHEMA " + schemaName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP VIEW concatenation", () => {
		const code = 'const q = "DROP VIEW " + viewName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags TRUNCATE TABLE concatenation", () => {
		const code = 'const q = "TRUNCATE TABLE " + tableName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("does NOT flag plain English containing 'update'/'drop' without SQL syntax", () => {
		const code = 'const msg = "dirty update: " + name;\nconst note = "drop the file: " + name;';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("flags the selectConcatPrefix shape (SELECT immediately followed by concat, no FROM on the line)", () => {
		const code = 'let sql = "SELECT" + col;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
});

describe("checkSqlStringConcat — interpolation & exemptions", () => {
	it("does NOT flag a comma inside a column list literal", () => {
		const code = 'const q = "SELECT id, name FROM users";';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("does NOT flag a plain literal with no concatenation", () => {
		const code = 'const q = "SELECT * FROM users";';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("does NOT flag a `?` placeholder", () => {
		const code = 'db.query("SELECT * FROM users WHERE id = ?", [id]);';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("does NOT flag a `:name` named placeholder even with concatenation elsewhere on the line", () => {
		const code = 'db.query("SELECT * FROM users WHERE id = :id " + extra, {id});';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("does NOT flag an event-listener callback shape", () => {
		const code = 'el.on("SELECT * FROM " + name);';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
});

describe("checkSqlStringConcat — match cap and exact shape", () => {
	it("caps at 10 matches and preserves the boundary", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `const q${i} = "SELECT * FROM t" + id${i};`);
		const code = lines.join("\n");
		const matches = checkSqlStringConcat(code, "db.ts");
		expect(matches).toHaveLength(10);
		expect(matches[9]?.line).toBe(10);
	});

	it("returns exact line number and trimmed/truncated text", () => {
		const longIdent = "x".repeat(200);
		const code = `\n   const q = "SELECT * FROM users WHERE id = " + ${longIdent};   \n`;
		const matches = checkSqlStringConcat(code, "db.ts");
		const rawLine = (code.split("\n")[1] ?? "");
		expect(matches).toEqual([{ line: 2, text: rawLine.trim().slice(0, 150) }]);
	});
});

describe("checkSqlEscapeHatchNonLiteral — extension coverage", () => {
	const code = "const q = sql.unsafe(tableName);";

	it("flags .tsx", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "Component.tsx").length).toBeGreaterThan(0);
	});
	it("flags .js", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.js").length).toBeGreaterThan(0);
	});
	it("flags .jsx", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "Component.jsx").length).toBeGreaterThan(0);
	});
	it("flags .mjs", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.mjs").length).toBeGreaterThan(0);
	});
	it("flags .cjs", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.cjs").length).toBeGreaterThan(0);
	});
	it("flags .mts", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.mts").length).toBeGreaterThan(0);
	});
	it("flags .cts", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.cts").length).toBeGreaterThan(0);
	});
	it("does NOT flag an unsupported extension", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "notes.txt")).toEqual([]);
	});
});

describe("checkSqlEscapeHatchNonLiteral — cap and exact shape", () => {
	it("caps at MATCH_LIMIT (10) matches", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `const q${i} = sql.unsafe(name${i});`);
		const code = lines.join("\n");
		const matches = checkSqlEscapeHatchNonLiteral(code, "db.ts");
		expect(matches).toHaveLength(10);
	});

	it("produces the exact line number and message, trimming trailing whitespace inside the match", () => {
		const code = "\nconst q = sql.unsafe(   tableName);\n";
		const matches = checkSqlEscapeHatchNonLiteral(code, "db.ts");
		expect(matches).toEqual([
			{
				line: 2,
				text: "SQL escape hatch (sql.unsafe() called with non-literal argument — should only wrap compile-time constants (schema names, etc.): const q = sql.unsafe(   tableName);",
			},
		]);
	});

	it("trims the quoted source line in the message body", () => {
		const code = "\n\t  const q = sql.unsafe(tableName);  \t\n";
		const matches = checkSqlEscapeHatchNonLiteral(code, "db.ts");
		expect(matches).toEqual([
			{
				line: 2,
				text: "SQL escape hatch (sql.unsafe() called with non-literal argument — should only wrap compile-time constants (schema names, etc.): const q = sql.unsafe(tableName);",
			},
		]);
	});

	it("attributes the message to the correct source line, not an off-by-one neighbor", () => {
		const code = ["const a = 1;", "const q = sql.unsafe(name);", "const c = 3;"].join("\n");
		const matches = checkSqlEscapeHatchNonLiteral(code, "db.ts");
		expect(matches).toEqual([
			{
				line: 2,
				text: "SQL escape hatch (sql.unsafe() called with non-literal argument — should only wrap compile-time constants (schema names, etc.): const q = sql.unsafe(name);",
			},
		]);
	});
});

describe("checkUbsHardcodedLocalhost — scannable extensions", () => {
	const exts = [
		".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
		".py", ".pyi",
		".go", ".rs",
		".java", ".kt", ".swift",
		".rb", ".php",
		".c", ".cc", ".cpp", ".cxx",
		".h", ".hpp", ".hxx",
	];
	it.each(exts)("flags a hardcoded localhost endpoint in %s", (ext) => {
		const code = 'const url = "http://localhost:3000";';
		const matches = checkUbsHardcodedLocalhost(code, `src/lib/client${ext}`);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag an unsupported extension", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "notes.txt")).toEqual([]);
	});

	it("does NOT fire on test files", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "src/foo.test.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — path normalization", () => {
	it("does NOT fire when a Windows-style backslash path lands in an examples/ segment", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "src\\examples\\dev.ts")).toEqual([]);
	});

	it("does NOT fire when an uppercase path segment matches an exemption case-insensitively", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "EXAMPLES/dev.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — path exemptions", () => {
	const code = 'const url = "http://localhost:3000";';

	it("does NOT fire in an examples/ directory", () => {
		expect(checkUbsHardcodedLocalhost(code, "examples/dev.ts")).toEqual([]);
	});
	it("does NOT fire in a singular example/ directory", () => {
		expect(checkUbsHardcodedLocalhost(code, "example/dev.ts")).toEqual([]);
	});
	it("does NOT fire in a /fixtures/ directory", () => {
		expect(checkUbsHardcodedLocalhost(code, "src/fixtures/db.ts")).toEqual([]);
	});
	it("does NOT fire in a dev/ directory", () => {
		expect(checkUbsHardcodedLocalhost(code, "dev/client.ts")).toEqual([]);
	});
	it("does NOT fire when the path contains 'config'", () => {
		expect(checkUbsHardcodedLocalhost(code, "src/config.ts")).toEqual([]);
	});
	it("does NOT fire for a .env file", () => {
		expect(checkUbsHardcodedLocalhost(code, "secrets/.env")).toEqual([]);
	});
	it("does NOT fire for a .env.example file", () => {
		expect(checkUbsHardcodedLocalhost(code, "secrets/.env.example")).toEqual([]);
	});

	it("STILL fires when 'examples' merely prefixes a filename (not a path segment)", () => {
		expect(checkUbsHardcodedLocalhost(code, "examplesx.ts").length).toBeGreaterThan(0);
	});
	it("STILL fires when 'dev' merely prefixes a directory name (devops/)", () => {
		expect(checkUbsHardcodedLocalhost(code, "devops/client.ts").length).toBeGreaterThan(0);
	});
	it("STILL fires for a file merely containing 'env' in its name", () => {
		expect(checkUbsHardcodedLocalhost(code, "environment.ts").length).toBeGreaterThan(0);
	});
});

describe("checkUbsHardcodedLocalhost — endpoint regex shapes", () => {
	it("flags a `//host` URL shape", () => {
		expect(checkUbsHardcodedLocalhost('fetch("http://localhost/api");', "src/x.ts").length).toBeGreaterThan(0);
	});
	it("flags an `@host` shape (connection string)", () => {
		expect(
			checkUbsHardcodedLocalhost('const dsn = "postgres://user:pass@localhost/db";', "src/x.ts").length,
		).toBeGreaterThan(0);
	});
	it("flags a bare host:port endpoint without quotes", () => {
		expect(checkUbsHardcodedLocalhost("const target = localhost:9000;", "src/x.ts").length).toBeGreaterThan(0);
	});
	it("does NOT flag localhost followed by non-digit punctuation with no other endpoint shape", () => {
		const code = 'log("info: localhost: reachable");';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT flag localhost embedded mid-identifier inside a string (not a bare quoted token)", () => {
		const code = 'const name = "xlocalhost";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT flag localhost with trailing characters inside a string (not a bare quoted token)", () => {
		const code = 'const name = "localhostx";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("STILL fires on a bare quoted host and a host:port endpoint", () => {
		expect(checkUbsHardcodedLocalhost('const h = "localhost";', "src/x.ts").length).toBeGreaterThan(0);
		expect(
			checkUbsHardcodedLocalhost("const u = `http://localhost:9229`;", "src/x.ts").length,
		).toBeGreaterThan(0);
	});
});

describe("checkUbsHardcodedLocalhost — per-line exemptions", () => {
	it("does NOT fire on a metadata-shaped assignment (description:)", () => {
		const code = 'const meta = { description: "http://localhost:3000" };';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a fix_instruction metadata field", () => {
		const code = 'fix_instruction: "set a clear default for local dev: http://localhost:8787"';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire inside a RegExp constructor call", () => {
		const code = 'const re = new RegExp("localhost");';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a `??` fallback default", () => {
		const code = 'const url = configured ?? "http://127.0.0.1:8787";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a `.includes()` membership test", () => {
		const code = 'if (url.includes("localhost")) { return; }';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a strict-equality test", () => {
		const code = 'const isLocal = host === "localhost";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a fallback-named declaration", () => {
		const code = 'const fallbackHost = "127.0.0.1";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("STILL fires on a plain baked endpoint constant that is not a default", () => {
		const code = 'const apiUrl = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts").length).toBeGreaterThan(0);
	});
});

describe("checkUbsHardcodedLocalhost — regex-literal self-detection guard", () => {
	it("does NOT fire on a single-line regex literal containing the token", () => {
		const code = "if (/https?:\\/\\/(localhost|127\\.0\\.0\\.1):\\d+/.test(line)) { /* … */ }";
		expect(checkUbsHardcodedLocalhost(code, "src/lib/check.ts")).toEqual([]);
	});
	it("does NOT fire on `new RegExp(...)` pattern-building templates", () => {
		const code = 'const pattern = new RegExp(`(?:curl|wget).*(?:localhost|127\\.0\\.0\\.1):${port}`, "i");';
		expect(checkUbsHardcodedLocalhost(code, "src/harness/evaluator/pre-tool.ts")).toEqual([]);
	});
	it("does NOT fire on a multi-line `new RegExp(` argument continuation", () => {
		const code = [
			"const pattern = new RegExp(",
			'\t`(?:curl|wget|fetch).*(?:localhost|127\\.0\\.0\\.1):${port}`,',
			'\t"i",',
			");",
		].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/harness/evaluator/pre-tool.ts")).toEqual([]);
	});
	it("STILL fires on a real fetch() endpoint even though a RegExp construction exists elsewhere in the file", () => {
		const code = [
			'const pattern = new RegExp("localhost", "i");',
			'await fetch("http://localhost:3000/api");',
		].join("\n");
		const matches = checkUbsHardcodedLocalhost(code, "src/lib/client.ts");
		expect(matches).toEqual([{ line: 2, text: 'await fetch("http://localhost:3000/api");' }]);
	});
});

describe("checkUbsHardcodedLocalhost — dev-gated exemption", () => {
	it("does NOT fire on a guarded dev-mode resolver branch", () => {
		const code = [
			"function resolveServerUrl(config, devMode) {",
			"  if (devMode && config.devPort) {",
			"    return `http://localhost:${config.devPort}/mcp`;",
			"  }",
			"  return config.url;",
			"}",
		].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/bio/servers.ts")).toEqual([]);
	});
	it("does NOT fire when the guarding conditional (within 3 lines) names a dev token", () => {
		const code = ["if (isDev) {", "  // route everything locally", '  url = "http://localhost:3000";', "}"].join(
			"\n",
		);
		expect(checkUbsHardcodedLocalhost(code, "src/lib/router.ts")).toEqual([]);
	});
	it("does NOT fire when the line itself names a DEV_ constant", () => {
		const code = 'registerServer(DEV_GATEWAY, "http://127.0.0.1:8080/gateway");';
		expect(checkUbsHardcodedLocalhost(code, "src/lib/register.ts")).toEqual([]);
	});
	it("STILL fires when the nearby identifier merely starts with dev-like letters (deviceUrl)", () => {
		const code = 'const deviceUrl = "http://localhost:3000/devices";';
		expect(checkUbsHardcodedLocalhost(code, "src/lib/devices.ts").length).toBeGreaterThan(0);
	});
	it("STILL fires on an unguarded endpoint even when a dev-gated block exists earlier", () => {
		const code = [
			"if (devMode) {",
			'  a = "http://localhost:1111";',
			"}",
			"const x = 1;",
			"const y = 2;",
			"const z = 3;",
			'const leaked = "http://localhost:9999/api";',
		].join("\n");
		const matches = checkUbsHardcodedLocalhost(code, "src/lib/mixed.ts");
		expect(matches).toEqual([{ line: 7, text: 'const leaked = "http://localhost:9999/api";' }]);
	});
	it("STILL fires when the preceding dev mention is not a conditional guard", () => {
		const code = ['const devNote = "see docs";', 'const url = "http://localhost:4000";'].join("\n");
		const matches = checkUbsHardcodedLocalhost(code, "src/lib/notes.ts");
		expect(matches).toEqual([{ line: 2, text: 'const url = "http://localhost:4000";' }]);
	});
});

describe("checkUbsHardcodedLocalhost — match cap and exact shape", () => {
	it("caps at 10 matches", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `const q${i} = "http://localhost:300${i}";`);
		const code = lines.join("\n");
		const matches = checkUbsHardcodedLocalhost(code, "src/x.ts");
		expect(matches).toHaveLength(10);
	});
	it("returns the exact 1-based line number and trimmed text", () => {
		const code = '\n   const url = "http://localhost:3000";   \n';
		const matches = checkUbsHardcodedLocalhost(code, "src/x.ts");
		expect(matches).toEqual([{ line: 2, text: 'const url = "http://localhost:3000";' }]);
	});
});
