// Tests for `ubs_print_debug_leak` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkPrintDebugLeak } from "../checks/ubs-language-specific.js";

describe("checkPrintDebugLeak", () => {
	it("flags `console.log` in a non-test, non-CLI file", () => {
		const code = "function process() {\n  console.log('debug');\n}\n";
		const matches = checkPrintDebugLeak(code, "src/lib/process.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Python `print(...)` outside test files", () => {
		const code = "def calc(x):\n    print(x)\n    return x * 2\n";
		const matches = checkPrintDebugLeak(code, "src/lib/calc.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Go `fmt.Println(...)`", () => {
		const code = "func process() {\n  fmt.Println(\"x\")\n}\n";
		const matches = checkPrintDebugLeak(code, "src/lib/proc.go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT fire on test files", () => {
		const code = "console.log('debug');";
		expect(checkPrintDebugLeak(code, "src/foo.test.ts")).toEqual([]);
	});

	it("does NOT fire on /commands/ entry-point files", () => {
		const code = "console.log('hello');";
		expect(checkPrintDebugLeak(code, "src/commands/foo.ts")).toEqual([]);
	});

	// FP refinement (139-repo audit, 2026-05): script/CLI/tutorial/tools
	// paths use stdout AS the product. Suppress to mirror the existing
	// `/commands/` `/cmd/` `/bin/` exemption.

	it("does NOT fire on `scripts/sync_version.py` (Supermodel mcpbr shape)", () => {
		// The actual mcpbr file had 194 print() hits — the canonical FP.
		const code = `def main():\n    print("v1.0.0")\n    print("done")\n`;
		expect(checkPrintDebugLeak(code, "mcpbr/scripts/sync_version.py")).toEqual([]);
	});

	it("does NOT fire on `cli/internal/setup/wizard.go` (Supermodel cli shape)", () => {
		// The wizard.go file had 13 fmt.Println — interactive wizard.
		const code = `func runWizard() {\n  fmt.Println("Welcome")\n  fmt.Println("Setup")\n}\n`;
		expect(checkPrintDebugLeak(code, "cli/internal/setup/wizard.go")).toEqual([]);
	});

	it("does NOT fire on `tools/codegen.ts` (build tool)", () => {
		const code = "function emit() { console.log('schema written'); }";
		expect(checkPrintDebugLeak(code, "repo/tools/codegen.ts")).toEqual([]);
	});

	it("does NOT fire on `tutorial/intro.py` (tutorial fixture)", () => {
		const code = "print('Hello, tutorial reader')";
		expect(checkPrintDebugLeak(code, "repo/tutorial/intro.py")).toEqual([]);
	});

	it("does NOT fire on `tutorials/getting-started.py` (plural)", () => {
		const code = "print('step 1')";
		expect(checkPrintDebugLeak(code, "docs/tutorials/getting-started.py")).toEqual([]);
	});

	// Positive cases — debug leak in real source MUST still fire.

	it("STILL flags `console.log` in `src/lib/auth.ts`", () => {
		const code = "export function authenticate(u) { console.log('user:', u); return u; }";
		expect(checkPrintDebugLeak(code, "src/lib/auth.ts").length).toBeGreaterThan(0);
	});

	it("STILL flags `print(...)` in `src/lib/processor.py`", () => {
		const code = "def process(x):\n    print(x)\n    return x\n";
		expect(checkPrintDebugLeak(code, "src/lib/processor.py").length).toBeGreaterThan(0);
	});

	it("STILL flags `fmt.Println` in `internal/handler.go` (not a script path)", () => {
		const code = "func handle() {\n  fmt.Println(\"x\")\n}\n";
		expect(checkPrintDebugLeak(code, "internal/handler.go").length).toBeGreaterThan(0);
	});

	it("STILL flags when path contains 'binary' (not 'bin/' segment)", () => {
		// Word-segment anchoring contract: `binary-encoding.ts` must NOT
		// be treated as a `bin/` path.
		const code = "console.log('debug');";
		expect(checkPrintDebugLeak(code, "src/binary-encoding.ts").length).toBeGreaterThan(0);
	});
});
