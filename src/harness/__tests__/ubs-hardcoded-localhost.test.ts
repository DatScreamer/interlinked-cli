// Tests for `ubs_hardcoded_localhost` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkUbsHardcodedLocalhost } from "../checks/ubs-language-specific.js";

describe("checkUbsHardcodedLocalhost", () => {
	it("flags hardcoded `localhost` in production source", () => {
		const code = "const URL = 'http://localhost:8000/api';\n";
		const matches = checkUbsHardcodedLocalhost(code, "src/lib/client.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags hardcoded `127.0.0.1`", () => {
		const code = "let host = '127.0.0.1';\n";
		const matches = checkUbsHardcodedLocalhost(code, "src/lib/server.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT fire on test files", () => {
		const code = "const URL = 'http://localhost:8000';";
		expect(checkUbsHardcodedLocalhost(code, "src/foo.test.ts")).toEqual([]);
	});

	it("does NOT fire on examples directory", () => {
		const code = "const URL = 'http://localhost:8000';";
		expect(checkUbsHardcodedLocalhost(code, "examples/dev.ts")).toEqual([]);
	});

	it("does NOT fire on config-named files", () => {
		const code = "const HOST = '127.0.0.1';";
		expect(checkUbsHardcodedLocalhost(code, "src/config.ts")).toEqual([]);
	});

	it("does NOT fire on comments in production source", () => {
		const code = [
			"// Local dev can use http://localhost:8000 while testing manually.",
			"export const host = process.env.API_HOST;",
		].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/lib/client.ts")).toEqual([]);
	});

	it("does NOT fire on non-source files", () => {
		const code = "The dev server runs at http://localhost:8000.";
		expect(checkUbsHardcodedLocalhost(code, "docs/setup.md")).toEqual([]);
	});
});
