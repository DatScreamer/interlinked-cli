// Tests for `ubs_regex_in_loop_no_compile` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkRegexInLoopNoCompile } from "../checks/ubs-language-specific.js";

describe("checkRegexInLoopNoCompile", () => {
	it("flags `re.match(pattern, x)` inside a for loop", () => {
		const code = "import re\nfor x in items:\n    if re.match(pattern, x):\n        pass\n";
		const matches = checkRegexInLoopNoCompile(code, "src/lib/scan.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `re.search(...)` inside a while loop", () => {
		const code = "import re\nwhile chunk:\n    re.search(pattern, chunk)\n    chunk = next()\n";
		const matches = checkRegexInLoopNoCompile(code, "src/lib/scan.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `re.match` outside a loop", () => {
		const code = "import re\nresult = re.match(pattern, x)\n";
		expect(checkRegexInLoopNoCompile(code, "src/lib/scan.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code = "for x in items:\n    re.match(pattern, x)";
		expect(checkRegexInLoopNoCompile(code, "src/lib/scan.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "import re\nfor x in items:\n    re.match(p, x)\n";
		expect(checkRegexInLoopNoCompile(code, "tests/test_scan.py")).toEqual([]);
	});
});
