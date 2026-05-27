// Smoke tests for the Python-language UBS detectors. The exhaustive
// red/green suites for each check live in src/harness/__tests__/ubs-*.test.ts
// and exercise these via the ubs-language-specific.ts barrel; this colocated
// file covers the module surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkMarshalLoad,
	checkOsSystemTainted,
	checkPickleUntrustedLoad,
	checkPickleWrapperLoad,
	checkPyMutableDefaultArg,
	checkPyNoneEquality,
	checkRegexInLoopNoCompile,
	checkShelveOpen,
	checkSubprocessShellTrue,
	checkTempfileMktempRace,
	checkTorchUnsafeLoad,
	checkXmlExternalEntity,
	checkYamlUnsafeLoad,
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

	it("checkMarshalLoad flags marshal.loads", () => {
		expect(checkMarshalLoad("obj = marshal.loads(buf)", "a.py").length).toBeGreaterThan(0);
		expect(checkMarshalLoad("obj = json.loads(buf)", "a.py")).toEqual([]);
	});

	it("checkShelveOpen flags shelve.open", () => {
		expect(checkShelveOpen("d = shelve.open(p)", "a.py").length).toBeGreaterThan(0);
		expect(checkShelveOpen("d = sqlite3.connect(p)", "a.py")).toEqual([]);
	});

	it("checkYamlUnsafeLoad flags bare yaml.load and skips yaml.safe_load", () => {
		expect(checkYamlUnsafeLoad("cfg = yaml.load(f)", "a.py").length).toBeGreaterThan(0);
		expect(checkYamlUnsafeLoad("cfg = yaml.safe_load(f)", "a.py")).toEqual([]);
	});

	it("checkTorchUnsafeLoad flags torch.load without weights_only=True", () => {
		expect(checkTorchUnsafeLoad("m = torch.load(p)", "a.py").length).toBeGreaterThan(0);
		expect(checkTorchUnsafeLoad("m = torch.load(p, weights_only=True)", "a.py")).toEqual([]);
	});

	it("checkPickleWrapperLoad flags joblib.load and skips safe np.load", () => {
		expect(checkPickleWrapperLoad("m = joblib.load(p)", "a.py").length).toBeGreaterThan(0);
		expect(checkPickleWrapperLoad("arr = np.load(p)", "a.py")).toEqual([]);
	});
});
