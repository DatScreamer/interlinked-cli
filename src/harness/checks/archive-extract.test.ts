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

	// Evidence backfill (Check Evidence Contract) — checkArchiveExtractTraversal
	// (ubs_archive_extract_traversal). Real zip-slip shapes: a full extraction
	// handler for an attacker-supplied archive, where a crafted entry name
	// (`../../etc/cron.d/x`) would land outside the intended destination
	// directory — the CVE-2007-4559 class this check exists to catch.
	describe("checkArchiveExtractTraversal (ubs_archive_extract_traversal) — evidence backfill", () => {
		it("P1: flags an upload handler extracting an attacker-supplied tarball with no member-path sanitizer", () => {
			const code = [
				"def handle_upload(archive_path, dest_dir):",
				"    with tarfile.open(archive_path) as tf:",
				"        # a crafted entry name like '../../etc/cron.d/x' escapes dest_dir",
				"        tf.extractall(dest_dir)",
			].join("\n");
			const matches = checkArchiveExtractTraversal(code, "src/upload_handler.py");
			expect(matches).toHaveLength(1);
			expect(matches[0]?.line).toBe(4);
		});

		it("P2: flags an unpack handler extracting an attacker-supplied zip via adm-zip with no path validation", () => {
			const code = [
				"export function unpackUpload(zipPath: string, dest: string) {",
				"  const zip = new AdmZip(zipPath);",
				"  // entries can carry '../' segments that escape `dest`",
				"  zip.extractAllTo(dest, true);",
				"}",
			].join("\n");
			const matches = checkArchiveExtractTraversal(code, "src/uploads/unpack.ts");
			expect(matches).toHaveLength(1);
			expect(matches[0]?.line).toBe(4);
		});
	});
});
