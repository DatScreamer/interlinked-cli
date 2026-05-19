// Smoke tests for the cross-language UBS detectors. The exhaustive red/green
// suites live in src/harness/__tests__/ubs-sql-string-concat.test.ts and
// ubs-hardcoded-localhost.test.ts and exercise these via the
// ubs-language-specific.ts barrel; this colocated file covers the module
// surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
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
});
