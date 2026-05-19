// Smoke tests for the Python-language UBS detectors. The exhaustive
// red/green suites for each check live in src/harness/__tests__/ubs-*.test.ts
// and exercise these via the ubs-language-specific.ts barrel; this colocated
// file covers the module surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkOsSystemTainted,
	checkPickleUntrustedLoad,
	checkPyMutableDefaultArg,
	checkPyNoneEquality,
	checkRegexInLoopNoCompile,
	checkSubprocessShellTrue,
	checkTempfileMktempRace,
	checkXmlExternalEntity,
} from "./python-checks.js";

describe("ubs-language-specific/python-checks", () => {
	it("checkSubprocessShellTrue flags shell=True", () => {
		const code = "subprocess.run(cmd, shell=True)";
		expect(checkSubprocessShellTrue(code, "a.py").length).toBeGreaterThan(0);
		expect(checkSubprocessShellTrue(code, "a.ts")).toEqual([]);
	});

	it("checkPyNoneEquality flags `x == None`", () => {
		expect(checkPyNoneEquality("if x == None:", "a.py").length).toBeGreaterThan(0);
		expect(checkPyNoneEquality("if x is None:", "a.py")).toEqual([]);
	});

	it("checkPyMutableDefaultArg flags `def f(x=[])`", () => {
		expect(checkPyMutableDefaultArg("def f(x=[]):", "a.py").length).toBeGreaterThan(0);
		expect(checkPyMutableDefaultArg("def f(x=None):", "a.py")).toEqual([]);
	});

	it("checkTempfileMktempRace flags tempfile.mktemp()", () => {
		expect(checkTempfileMktempRace("p = tempfile.mktemp()", "a.py").length).toBeGreaterThan(0);
		expect(checkTempfileMktempRace("p = tempfile.mkstemp()", "a.py")).toEqual([]);
	});

	it("checkPickleUntrustedLoad flags pickle.load", () => {
		expect(checkPickleUntrustedLoad("x = pickle.load(f)", "a.py").length).toBeGreaterThan(0);
		expect(checkPickleUntrustedLoad("x = json.load(f)", "a.py")).toEqual([]);
	});

	it("checkXmlExternalEntity flags an etree import paired with a parse call", () => {
		const code = "import xml.etree.ElementTree as ET\nroot = ET.parse(src)";
		expect(checkXmlExternalEntity(code, "a.py").length).toBeGreaterThan(0);
	});

	it("checkOsSystemTainted flags os.system with an identifier arg", () => {
		expect(checkOsSystemTainted("os.system(cmd)", "a.py").length).toBeGreaterThan(0);
	});

	it("checkRegexInLoopNoCompile flags re.match inside a loop", () => {
		const code = "for line in lines:\n    re.match(pat, line)";
		expect(checkRegexInLoopNoCompile(code, "a.py").length).toBeGreaterThan(0);
	});
});
