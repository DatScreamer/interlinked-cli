import { describe, expect, it } from "vitest";
import { checkArchiveExtractTraversal } from "./archive-extract.js";

describe("checkArchiveExtractTraversal (ubs_archive_extract_traversal)", () => {
	it("fires on unguarded Python extractall (tarfile + zipfile)", () => {
		expect(checkArchiveExtractTraversal("tf.extractall(dest)", "src/a.py")).toHaveLength(1);
		expect(checkArchiveExtractTraversal("zipfile.ZipFile(p).extractall('/out')", "src/a.py")).toHaveLength(1);
	});

	it("fires on Node tar.x / tar.extract / adm-zip extractAllTo", () => {
		expect(checkArchiveExtractTraversal("await tar.x({ file: 'a.tgz', cwd: dest });", "src/a.ts")).toHaveLength(1);
		expect(checkArchiveExtractTraversal("tar.extract({ file });", "src/a.js")).toHaveLength(1);
		expect(checkArchiveExtractTraversal("new AdmZip(buf).extractAllTo(dest, true);", "src/a.ts")).toHaveLength(1);
	});

	it("does NOT fire on Python extractall guarded by a filter= sanitizer (3.12+)", () => {
		expect(checkArchiveExtractTraversal("tf.extractall(dest, filter='data')", "src/a.py")).toEqual([]);
		expect(checkArchiveExtractTraversal("tf.extractall(path=dest, filter=tarfile.data_filter)", "src/a.py")).toEqual([]);
	});

	it("does NOT fire on unrelated .extract calls, comments, strings, or wrong ext", () => {
		expect(checkArchiveExtractTraversal("const m = regex.extract(input);", "src/a.ts")).toEqual([]);
		expect(checkArchiveExtractTraversal("# legacy: tf.extractall(dest) was unsafe", "src/a.py")).toEqual([]);
		expect(checkArchiveExtractTraversal('const doc = "call tar.x to extract";', "src/a.ts")).toEqual([]);
		expect(checkArchiveExtractTraversal("tf.extractall(dest)", "src/a.rs")).toEqual([]);
	});

	it("is exempt in test files (throwaway fixtures)", () => {
		expect(checkArchiveExtractTraversal("tf.extractall(dest)", "src/a.test.ts")).toEqual([]);
		expect(checkArchiveExtractTraversal("zf.extractall(d)", "tests/test_x.py")).toEqual([]);
	});
});
