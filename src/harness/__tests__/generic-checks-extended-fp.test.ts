// Split from generic-checks-extended.test.ts — false-positive reduction suites:
// checkHardcodedCredentials, checkFloatEquality, checkInfiniteRecursion,
// checkConsoleDebug, checkAwaitInLoop.

import { describe, expect, it } from "vitest";
import {
	checkAwaitInLoop,
	checkConsoleDebug,
	checkFloatEquality,
	checkHardcodedCredentials,
	checkInfiniteRecursion,
} from "../generic-checks.js";

// ===========================================
// FP Reduction: checkHardcodedCredentials
// ===========================================

describe("checkHardcodedCredentials — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag placeholder value 'changeme'", () => {
		const code = `const password = "changeme";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag 'your-api-key-here' placeholder", () => {
		const code = `const apiKey = "your-api-key-here";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag 'example-secret' prefix", () => {
		const code = `const secret = "example-secret-value";`;
		expect(checkHardcodedCredentials(code, "auth.ts")).toEqual([]);
	});

	it("does NOT flag 'test_key_for_demo' prefix", () => {
		const code = `const API_KEY = "test_key_for_demo";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag Zod schema annotation", () => {
		const code = "password: z.string().min(8)";
		expect(checkHardcodedCredentials(code, "schema.ts")).toEqual([]);
	});

	it("does NOT flag variable with Pattern suffix", () => {
		const code = `const passwordPattern = "^[A-Za-z0-9]{8,}$";`;
		expect(checkHardcodedCredentials(code, "validation.ts")).toEqual([]);
	});

	it("does NOT flag variable with Validator suffix", () => {
		const code = `const passwordValidator = "must-contain-special";`;
		expect(checkHardcodedCredentials(code, "validation.ts")).toEqual([]);
	});

	it("does NOT flag variable with Name suffix", () => {
		const code = `const secretName = "my-secret-vault-key";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag variable with Schema suffix", () => {
		const code = `const apiKeySchema = "string-uuid-format";`;
		expect(checkHardcodedCredentials(code, "types.ts")).toEqual([]);
	});

	it("does NOT flag 'mock' prefix values", () => {
		const code = `const password = "mock-password-value";`;
		expect(checkHardcodedCredentials(code, "setup.ts")).toEqual([]);
	});

	it("does NOT flag 'dummy' prefix values", () => {
		const code = `const secret = "dummy-secret-for-dev";`;
		expect(checkHardcodedCredentials(code, "dev.ts")).toEqual([]);
	});

	it("does NOT flag exact value 'disabled'", () => {
		const code = `const API_KEY = "disabled";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag exact value 'redacted'", () => {
		const code = `const secret = "redacted";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag variable with Header suffix", () => {
		const code = `const authTokenHeader = "X-Auth-Token-Value";`;
		expect(checkHardcodedCredentials(code, "http.ts")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects real-looking password", () => {
		const code = `const password = "supersecret123";`;
		expect(checkHardcodedCredentials(code, "config.ts").length).toBeGreaterThan(0);
	});

	it("still detects Stripe-style API key", () => {
		const code = `const apiKey = "sk-abc123def456";`;
		expect(checkHardcodedCredentials(code, "payment.ts").length).toBeGreaterThan(0);
	});

	it("still detects generic secret value", () => {
		const code = `const secret = "my-super-secret-value";`;
		expect(checkHardcodedCredentials(code, "auth.ts").length).toBeGreaterThan(0);
	});

	it("still detects hex string secret", () => {
		// Reason: test fixture — a synthetic hex string used to exercise
		// the hardcoded-credentials detector.
		// nosemgrep: generic.secrets.security.detected-generic-secret.detected-generic-secret
		const code = `API_SECRET = "a8f2e9b1c3d4567890abcdef12345678"`;
		expect(checkHardcodedCredentials(code, "config.ts").length).toBeGreaterThan(0);
	});

	it("still detects access_token with real value", () => {
		// Reason: test fixture — a synthetic GH token assembled at runtime
		// so the source file itself is not flagged by the secrets scanner.
		// nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
		const fakeToken = `${"gh" + "p_"}realtoken1234567890abcdef`;
		const code = `const access_token = "${fakeToken}";`;
		expect(checkHardcodedCredentials(code, "github.ts").length).toBeGreaterThan(0);
	});
});

// ===========================================
// Cross-language coverage (ungated 2026-06-12)
// ===========================================
// The credential pattern is language-agnostic, so it now runs on every file
// the harness scans — not just the JS/TS/Py/Go/Rust/Java allowlist it used to
// gate on. These pin firing in other languages + config formats, plus the
// test/vendored/generated exemptions.
describe("checkHardcodedCredentials — cross-language coverage", () => {
	const REAL = "a8f2e9b1c3d4567890abcdef12345678";

	it("fires on a Python assignment", () => {
		expect(checkHardcodedCredentials(`api_key = "${REAL}"`, "app/settings.py").length).toBeGreaterThan(0);
	});
	it("fires on a PHP assignment", () => {
		expect(checkHardcodedCredentials(`$apiKey = "${REAL}";`, "src/Config.php").length).toBeGreaterThan(0);
	});
	it("fires on a Ruby assignment", () => {
		expect(checkHardcodedCredentials(`SECRET = "${REAL}"`, "config/secrets.rb").length).toBeGreaterThan(0);
	});
	it("fires on a Go assignment", () => {
		expect(checkHardcodedCredentials(`authToken := "${REAL}"`, "main.go").length).toBeGreaterThan(0);
	});
	it("fires in a YAML / config value", () => {
		expect(checkHardcodedCredentials(`password: "${REAL}"`, "deploy/values.yaml").length).toBeGreaterThan(0);
	});
	it("fires in a .env file", () => {
		expect(checkHardcodedCredentials(`API_SECRET="${REAL}"`, ".env").length).toBeGreaterThan(0);
	});

	it("still skips test files (exemption)", () => {
		expect(checkHardcodedCredentials(`password = "${REAL}"`, "auth.test.ts")).toEqual([]);
	});
	it("skips vendored / fixture paths (exemption)", () => {
		expect(checkHardcodedCredentials(`password = "${REAL}"`, "node_modules/x/index.js")).toEqual([]);
	});
	it("skips generated files (exemption)", () => {
		const gen = `// @generated by codegen — do not edit\nconst apiKey = "${REAL}";`;
		expect(checkHardcodedCredentials(gen, "gen/config.ts")).toEqual([]);
	});
});

// ===========================================
// FP Reduction: checkFloatEquality
// ===========================================

describe("checkFloatEquality — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag === 0.0 (exact zero)", () => {
		const code = "if (x === 0.0) {}";
		expect(checkFloatEquality(code, "math.ts")).toEqual([]);
	});

	it("does NOT flag === 0.5 (binary-representable)", () => {
		const code = "if (opacity === 0.5) {}";
		expect(checkFloatEquality(code, "style.ts")).toEqual([]);
	});

	it("does NOT flag !== 1.0 (binary-representable)", () => {
		const code = "if (scale !== 1.0) {}";
		expect(checkFloatEquality(code, "transform.ts")).toEqual([]);
	});

	it("does NOT flag === 0.25 (binary-representable)", () => {
		const code = "if (factor === 0.25) {}";
		expect(checkFloatEquality(code, "calc.ts")).toEqual([]);
	});

	it("does NOT flag === 2.0 (integer-valued float)", () => {
		const code = "if (x === 2.0) {}";
		expect(checkFloatEquality(code, "math.ts")).toEqual([]);
	});

	it("does NOT flag === 0.75 (binary-representable)", () => {
		const code = "if (progress === 0.75) {}";
		expect(checkFloatEquality(code, "ui.ts")).toEqual([]);
	});

	it("does NOT flag === 0.125 (binary-representable)", () => {
		const code = "if (step === 0.125) {}";
		expect(checkFloatEquality(code, "grid.ts")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects === 0.1 (NOT binary-representable)", () => {
		const code = "if (x === 0.1) {}";
		expect(checkFloatEquality(code, "math.ts").length).toBeGreaterThan(0);
	});

	it("still detects !== 3.14 (NOT binary-representable)", () => {
		const code = "if (result !== 3.14) { throw new Error(); }";
		expect(checkFloatEquality(code, "calc.js").length).toBeGreaterThan(0);
	});

	it("still detects 0.3 === sum (NOT binary-representable)", () => {
		const code = "if (0.3 === sum) {}";
		expect(checkFloatEquality(code, "math.ts").length).toBeGreaterThan(0);
	});

	it("still detects === 9.99 (NOT binary-representable)", () => {
		const code = "if (price === 9.99) {}";
		expect(checkFloatEquality(code, "billing.ts").length).toBeGreaterThan(0);
	});

	it("still detects === 0.7 (NOT binary-representable)", () => {
		const code = "if (ratio === 0.7) {}";
		expect(checkFloatEquality(code, "util.ts").length).toBeGreaterThan(0);
	});
});

// ===========================================
// FP Reduction: checkInfiniteRecursion
// ===========================================

describe("checkInfiniteRecursion — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag function name in a comment", () => {
		const code = "function helper() {\n  // Call helper() to reset\n  return 42;\n}";
		expect(checkInfiniteRecursion(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag function name in a string", () => {
		const code =
			'function render() {\n  console.log("call render() for update");\n  return null;\n}';
		expect(checkInfiniteRecursion(code, "ui.ts")).toEqual([]);
	});

	it("does NOT flag guard via logical AND operator", () => {
		const code = "function walk(n) {\n  n > 0 && walk(n - 1);\n}";
		expect(checkInfiniteRecursion(code, "traverse.ts")).toEqual([]);
	});

	it("does NOT flag guard via logical OR operator", () => {
		const code = "function proc(arr) {\n  arr.length === 0 || proc(arr.slice(1));\n}";
		expect(checkInfiniteRecursion(code, "list.ts")).toEqual([]);
	});

	it("does NOT flag guard via comparison operator", () => {
		const code = "function count(n) {\n  if (n <= 0) return 0;\n  return 1 + count(n - 1);\n}";
		expect(checkInfiniteRecursion(code, "math.ts")).toEqual([]);
	});

	it("does NOT flag guard via .length check", () => {
		const code =
			"function flatten(arr) {\n  if (arr.length === 0) return [];\n  return [arr[0], ...flatten(arr.slice(1))];\n}";
		expect(checkInfiniteRecursion(code, "array.ts")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects self-call without any guard", () => {
		const code = "function recurse() {\n    recurse();\n}";
		expect(checkInfiniteRecursion(code, "util.ts").length).toBeGreaterThan(0);
	});

	it("still detects self-call with only logging (no guard)", () => {
		const code = "function loop(x) {\n    console.log(x);\n    loop(x);\n}";
		expect(checkInfiniteRecursion(code, "debug.ts").length).toBeGreaterThan(0);
	});

	it("still detects arrow function self-call without guard", () => {
		const code = "const tick = () => {\n    doWork();\n    tick();\n}";
		expect(checkInfiniteRecursion(code, "timer.ts").length).toBeGreaterThan(0);
	});
});

// ===========================================
// FP Reduction: checkConsoleDebug (Go/C)
// ===========================================

describe("checkConsoleDebug — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag Go file with 1 fmt.Println (intentional output)", () => {
		const code = `package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Server started on :8080")\n}`;
		expect(checkConsoleDebug(code, "src/app.go")).toEqual([]);
	});

	it("does NOT flag Go file with 2 fmt.Println (intentional output)", () => {
		const code = `package main\n\nimport "fmt"\n\nfunc run() {\n    fmt.Println("Starting...")\n    fmt.Println("Ready")\n}`;
		expect(checkConsoleDebug(code, "src/app.go")).toEqual([]);
	});

	it("does NOT flag C file in examples directory", () => {
		const code = `#include <stdio.h>\nvoid demo() {\n    printf("result: %d\\n", 42);\n}`;
		expect(checkConsoleDebug(code, "examples/demo.c")).toEqual([]);
	});

	it("does NOT flag C file with 'example' in name", () => {
		const code = `#include <stdio.h>\nvoid show() {\n    printf("output: %s\\n", msg);\n}`;
		expect(checkConsoleDebug(code, "src/example_usage.c")).toEqual([]);
	});

	it("does NOT flag C file in samples directory", () => {
		const code = `void sample() {\n    printf("value = %d\\n", x);\n}`;
		expect(checkConsoleDebug(code, "samples/test.c")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects Go file with 4+ fmt.Println (debug sprawl)", () => {
		const code = `package main\nimport "fmt"\nfunc debug() {\n    fmt.Println("a")\n    fmt.Println("b")\n    fmt.Println("c")\n    fmt.Println("d")\n}`;
		expect(checkConsoleDebug(code, "src/handler.go").length).toBeGreaterThan(0);
	});

	it("still detects JS console.log", () => {
		const code = `function process() {\n    console.log("debug value:", x);\n}`;
		expect(checkConsoleDebug(code, "src/utils.ts").length).toBeGreaterThan(0);
	});

	it("still detects Rust dbg! macro", () => {
		const code = "fn process(x: i32) {\n    dbg!(x);\n}";
		expect(checkConsoleDebug(code, "src/lib.rs").length).toBeGreaterThan(0);
	});

	it("still detects C printf in regular src file", () => {
		const code = `void parse() {\n    printf("x=%d\\n", x);\n}`;
		expect(checkConsoleDebug(code, "src/parser.c").length).toBeGreaterThan(0);
	});
});

// ===========================================
// FP Reduction: checkAwaitInLoop
// ===========================================

describe("checkAwaitInLoop — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag await inside nested async arrow in loop (promise collection)", () => {
		const code = `for (const id of ids) {
    promises.push(async () => {
        await api.get(id);
    });
}`;
		expect(checkAwaitInLoop(code, "fetch.ts")).toEqual([]);
	});

	it("does NOT flag await inside nested async callback in loop", () => {
		const code = `for (const item of items) {
    queue.add(async () => {
        const result = await process(item);
        return result;
    });
}`;
		expect(checkAwaitInLoop(code, "queue.ts")).toEqual([]);
	});

	it("does NOT flag await inside nested async function in loop", () => {
		const code = `for (const task of tasks) {
    const handler = async function() {
        await task.execute();
    };
    handlers.push(handler());
}`;
		expect(checkAwaitInLoop(code, "runner.ts")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects direct await in for-of loop", () => {
		const code = "for (const x of xs) {\n    await fetch(x);\n}";
		expect(checkAwaitInLoop(code, "api.ts").length).toBeGreaterThan(0);
	});

	it("still detects direct await in for loop", () => {
		const code =
			"for (let i = 0; i < items.length; i++) {\n    const r = await db.query(items[i]);\n}";
		expect(checkAwaitInLoop(code, "data.ts").length).toBeGreaterThan(0);
	});

	it("still detects direct await in while loop", () => {
		const code =
			"while (hasMore) {\n    const page = await fetchPage(cursor);\n    hasMore = page.next;\n}";
		expect(checkAwaitInLoop(code, "paginate.ts").length).toBeGreaterThan(0);
	});
});
