// Tests for `ubs_xml_external_entity` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkXmlExternalEntity } from "../checks/ubs-language-specific.js";

describe("checkXmlExternalEntity", () => {
	it("flags `import xml.etree.ElementTree`", () => {
		const code = "import xml.etree.ElementTree as ET\n";
		const matches = checkXmlExternalEntity(code, "src/parser.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `from xml.dom import minidom`", () => {
		const code = "from xml.dom import minidom\n";
		const matches = checkXmlExternalEntity(code, "src/parser.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `from lxml import etree`", () => {
		const code = "from lxml import etree\n";
		const matches = checkXmlExternalEntity(code, "src/parser.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag if defusedxml is also imported", () => {
		const code = "import defusedxml.ElementTree as ET\nimport xml.etree.ElementTree as fallback\n";
		expect(checkXmlExternalEntity(code, "src/parser.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code = "import xml.etree.ElementTree";
		expect(checkXmlExternalEntity(code, "src/parser.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "import xml.etree.ElementTree as ET\n";
		expect(checkXmlExternalEntity(code, "tests/test_parser.py")).toEqual([]);
	});
});
