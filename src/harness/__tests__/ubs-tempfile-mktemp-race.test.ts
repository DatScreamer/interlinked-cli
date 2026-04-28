// Tests for `ubs_tempfile_mktemp_race` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkTempfileMktempRace } from "../checks/ubs-language-specific.js";

describe("checkTempfileMktempRace", () => {
	it("flags Python `tempfile.mktemp(...)`", () => {
		const code = "import tempfile\npath = tempfile.mktemp(suffix='.txt')\n";
		const matches = checkTempfileMktempRace(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `tempfile.NamedTemporaryFile`", () => {
		const code = "import tempfile\nf = tempfile.NamedTemporaryFile()\n";
		expect(checkTempfileMktempRace(code, "src/foo.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code = "tempfile.mktemp(); // not python";
		expect(checkTempfileMktempRace(code, "src/foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "tempfile.mktemp()";
		expect(checkTempfileMktempRace(code, "tests/test_foo.py")).toEqual([]);
	});
});
