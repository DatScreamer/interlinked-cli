// Tests for `ubs_os_system_tainted` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkOsSystemTainted } from "../checks/ubs-language-specific.js";

describe("checkOsSystemTainted", () => {
	it("flags `os.system(cmd)` with identifier arg", () => {
		const code = "import os\nos.system(cmd)\n";
		const matches = checkOsSystemTainted(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `os.popen(user_input)`", () => {
		const code = "import os\nos.popen(user_input)\n";
		const matches = checkOsSystemTainted(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `os.system('ls')` (string literal)", () => {
		const code = "import os\nos.system('ls')\n";
		expect(checkOsSystemTainted(code, "src/foo.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code = "os.system(cmd);";
		expect(checkOsSystemTainted(code, "src/foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "os.system(cmd)";
		expect(checkOsSystemTainted(code, "tests/test_foo.py")).toEqual([]);
	});
});
