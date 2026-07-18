import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DoctestExec } from "../harness/doctest.js";
import { findMarkdownFiles, runDoctestSuite } from "./doctest.js";

const DOC = ["```bash doctest", "cmd-a", "```", "```bash", "rm -rf /", "```", "```sh doctest", "cmd-b", "```"].join(
	"\n",
);

describe("runDoctestSuite", () => {
	const readFile = (p: string): string => (p === "doc.md" ? DOC : "");

	it("runs only doctest blocks and reports failures with file+line", () => {
		const exec: DoctestExec = (code) => (code === "cmd-b" ? { exitCode: 2 } : { exitCode: 0 });
		const r = runDoctestSuite(["doc.md"], readFile, exec);
		expect(r.total).toBe(2);
		expect(r.failed).toBe(1);
		expect(r.failures).toEqual([{ file: "doc.md", line: 7, exitCode: 2 }]);
	});

	it("never runs an untagged (illustrative) block", () => {
		const ran: string[] = [];
		runDoctestSuite(["doc.md"], readFile, (code) => {
			ran.push(code);
			return { exitCode: 0 };
		});
		expect(ran).toEqual(["cmd-a", "cmd-b"]);
		expect(ran).not.toContain("rm -rf /");
	});

	it("skips a file that can't be read", () => {
		const r = runDoctestSuite(["missing.md"], () => {
			throw new Error("ENOENT");
		}, () => ({ exitCode: 0 }));
		expect(r.total).toBe(0);
	});
});

describe("findMarkdownFiles", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "doctest-find-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("finds .md files recursively and skips node_modules", () => {
		mkdirSync(join(cwd, "docs"), { recursive: true });
		mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(cwd, "README.md"), "#");
		writeFileSync(join(cwd, "docs", "guide.md"), "#");
		writeFileSync(join(cwd, "node_modules", "pkg", "readme.md"), "#");
		writeFileSync(join(cwd, "notes.txt"), "x");
		const found = findMarkdownFiles(cwd).map((f) => f.replace(`${cwd}/`, "")).sort();
		expect(found).toEqual(["README.md", "docs/guide.md"]);
	});
});
