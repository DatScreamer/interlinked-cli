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

	it("does NOT fire on regex literals containing the literal token", () => {
		// Self-detection regression: this check (and supply-chain.ts's
		// checkHardcodedLocalhost) contain `/…localhost…/` literals as their
		// implementation. Without stripRegexLiterals before matching, the
		// rule trips on its own source.
		const code = "if (/https?:\\/\\/(localhost|127\\.0\\.0\\.1):\\d+/.test(line)) { /* … */ }";
		expect(checkUbsHardcodedLocalhost(code, "src/lib/check.ts")).toEqual([]);
	});

	it("does NOT fire on `new RegExp(...)` constructor pattern strings", () => {
		// pre-tool.ts's curl-to-MCP detector builds regexes via
		// `new RegExp(\`...localhost...\`)` so it can interpolate a port.
		// These are pattern-matchers for agent commands, not endpoint
		// configs — the constructor argument intentionally contains the
		// literal token.
		const code =
			'const pattern = new RegExp(`(?:curl|wget).*(?:localhost|127\\.0\\.0\\.1):${port}`, "i");';
		expect(checkUbsHardcodedLocalhost(code, "src/harness/evaluator/pre-tool.ts")).toEqual([]);
	});

	it("does NOT fire on multi-line `new RegExp(` argument continuation", () => {
		// Real call site in pre-tool.ts splits the constructor across lines:
		//   const pattern = new RegExp(
		//     `...localhost...:${port}`,
		//     "i",
		//   );
		// The literal lives one line below the constructor call; without the
		// previous-line check, the exemption misses it.
		const code = [
			"const pattern = new RegExp(",
			'\t`(?:curl|wget|fetch).*(?:localhost|127\\.0\\.0\\.1):${port}`,',
			'\t"i",',
			");",
		].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/harness/evaluator/pre-tool.ts")).toEqual([]);
	});

	it("STILL fires on a real fetch() endpoint in production source", () => {
		// Negative regression: the RegExp exemption must not weaken
		// detection of the canonical bug shape.
		const code = 'await fetch("http://localhost:3000/api");';
		const matches = checkUbsHardcodedLocalhost(code, "src/lib/client.ts");
		expect(matches.length).toBeGreaterThan(0);
	});
});
