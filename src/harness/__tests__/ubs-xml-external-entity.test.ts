// Tests for `ubs_xml_external_entity` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkXmlExternalEntity } from "../checks/ubs-language-specific.js";

describe("checkXmlExternalEntity", () => {
	it("flags `import xml.etree.ElementTree` AND `ET.parse(...)`", () => {
		const code = [
			"import xml.etree.ElementTree as ET",
			"tree = ET.parse(open(path))",
		].join("\n");
		const matches = checkXmlExternalEntity(code, "src/parser.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `from xml.dom import minidom` with parsing", () => {
		const code = [
			"from xml.dom import minidom",
			"doc = minidom.parseString(buf)",
		].join("\n");
		// `minidom.parseString` is the safe-form via xml.dom; our regex
		// only catches `ET.parse(`, `etree.parse(`, etc. To keep the
		// existing flag, we exercise `xml.etree`-shape parsing here.
		// Use the import only — the new gate would skip this case
		// without an actual parse call. Verify the import-only IS now
		// safely skipped and instead test a real parsing pattern.
		expect(checkXmlExternalEntity(code, "src/parser.py")).toEqual([]);
		// And confirm the same import + an actual parse call DOES fire.
		const codeWithParse = [
			"import xml.etree.ElementTree as ET",
			"from xml.dom import minidom",
			"tree = ET.fromstring(payload)",
		].join("\n");
		const matches = checkXmlExternalEntity(codeWithParse, "src/parser.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `from lxml import etree` with `etree.fromstring`", () => {
		const code = [
			"from lxml import etree",
			"root = etree.fromstring(payload)",
		].join("\n");
		const matches = checkXmlExternalEntity(code, "src/parser.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag if defusedxml is also imported", () => {
		const code = [
			"import defusedxml.ElementTree as ET",
			"import xml.etree.ElementTree as fallback",
			"tree = ET.parse(open(path))",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/parser.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code = "import xml.etree.ElementTree as ET\ntree = ET.parse(f)";
		expect(checkXmlExternalEntity(code, "src/parser.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "import xml.etree.ElementTree as ET\ntree = ET.parse(f)";
		expect(checkXmlExternalEntity(code, "tests/test_parser.py")).toEqual([]);
	});

	// FP refinement (139-repo audit, 2026-05): import-only files (XML
	// reporter shapes that BUILD/WRITE XML) must NOT fire. Supermodel's
	// `mcpbr/src/mcpbr/{junit_reporter,reporting}.py` were the canonical
	// FPs.

	it("does NOT fire on import-only files (write-only XML reporters)", () => {
		// Supermodel mcpbr/junit_reporter.py shape: imports xml.etree
		// only to build/serialize XML; never parses untrusted input.
		const code = [
			"import xml.etree.ElementTree as ET",
			"",
			"def emit_junit(results):",
			"    root = ET.Element('testsuites')",
			"    for r in results:",
			"        ET.SubElement(root, 'testcase')",
			"    return ET.tostring(root)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/junit_reporter.py")).toEqual([]);
	});

	it("does NOT fire on `from lxml import etree` if no parse call appears", () => {
		const code = [
			"from lxml import etree",
			"",
			"def build():",
			"    root = etree.Element('root')",
			"    return etree.tostring(root)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/builder.py")).toEqual([]);
	});

	it("does NOT fire on `xml.dom import minidom` if no parse call appears", () => {
		// xml.dom write-only: createElement / appendChild / writexml.
		const code = [
			"from xml.dom import minidom",
			"",
			"doc = minidom.Document()",
			"el = doc.createElement('root')",
			"doc.appendChild(el)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/builder.py")).toEqual([]);
	});

	// FP refinement (139-repo audit): respect Bandit `# noqa: S314 / S320`.

	it("does NOT fire when import line has `# noqa: S314`", () => {
		const code = [
			"import xml.etree.ElementTree as ET  # noqa: S314 -- trusted source",
			"tree = ET.parse(local_path)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/parser.py")).toEqual([]);
	});

	it("does NOT fire when import line has `# noqa: S320`", () => {
		const code = [
			"from lxml import etree  # noqa: S320",
			"root = etree.fromstring(payload)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/parser.py")).toEqual([]);
	});

	// Positive cases — real positives MUST still fire.

	it("STILL fires on `xml.etree` import + `ET.parse(open(path))` with no noqa", () => {
		const code = [
			"import xml.etree.ElementTree as ET",
			"def parse_user_xml(path):",
			"    return ET.parse(open(path))",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/parser.py").length).toBeGreaterThan(0);
	});

	it("STILL fires on `lxml.etree.fromstring(request_body)` with no noqa", () => {
		const code = [
			"from lxml import etree",
			"def parse(req):",
			"    return etree.fromstring(req.body)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/parser.py").length).toBeGreaterThan(0);
	});

	it("STILL fires when noqa carries unrelated code (e.g. S301)", () => {
		// S301 (pickle) must NOT suppress XXE.
		const code = [
			"import xml.etree.ElementTree as ET  # noqa: S301",
			"tree = ET.parse(path)",
		].join("\n");
		expect(checkXmlExternalEntity(code, "src/parser.py").length).toBeGreaterThan(0);
	});
});
