import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProjectRoot } from "./project-root.js";

// macOS tmpdir is a /var -> /private/var symlink. Realpath both fixture
// paths and expected results so equality holds regardless of symlinks.
const tmpRealRoot = realpathSync(tmpdir());

describe("findProjectRoot", () => {
	const tmpDirs: string[] = [];

	function makeTmp(prefix: string): string {
		const dir = realpathSync(mkdtempSync(join(tmpRealRoot, prefix)));
		tmpDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		while (tmpDirs.length > 0) {
			const dir = tmpDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	// --- Cases that MUST return a valid in-CWD root -----------------------

	it("returns harnessCwd for a file directly under it with a tsconfig.json", () => {
		const cwd = makeTmp("interlinked-projroot-tsconfig-");
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		const file = join(cwd, "index.ts");
		writeFileSync(file, "export const x = 1;\n");

		expect(findProjectRoot(file, cwd)).toBe(cwd);
	});

	it("returns harnessCwd for a file directly under it with a package.json", () => {
		const cwd = makeTmp("interlinked-projroot-pkg-");
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root" }));
		const file = join(cwd, "main.ts");
		writeFileSync(file, "export const x = 1;\n");

		expect(findProjectRoot(file, cwd)).toBe(cwd);
	});

	it("returns the nearest descendant sub-package, not harnessCwd", () => {
		const cwd = makeTmp("interlinked-projroot-nested-");
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root" }));
		const subPkg = join(cwd, "packages", "widget");
		mkdirSync(subPkg, { recursive: true });
		writeFileSync(join(subPkg, "package.json"), JSON.stringify({ name: "widget" }));
		const file = join(subPkg, "src", "widget.ts");
		mkdirSync(join(subPkg, "src"), { recursive: true });
		writeFileSync(file, "export const w = 1;\n");

		expect(findProjectRoot(file, cwd)).toBe(subPkg);
	});

	it("returns harnessCwd for a deeply nested file when only the root has a marker", () => {
		const cwd = makeTmp("interlinked-projroot-deep-");
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		const deep = join(cwd, "a", "b", "c");
		mkdirSync(deep, { recursive: true });
		const file = join(deep, "deep.ts");
		writeFileSync(file, "export const d = 1;\n");

		expect(findProjectRoot(file, cwd)).toBe(cwd);
	});

	it("resolves a relative file path against harnessCwd", () => {
		const cwd = makeTmp("interlinked-projroot-relative-");
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root" }));
		writeFileSync(join(cwd, "rel.ts"), "export const r = 1;\n");

		expect(findProjectRoot("rel.ts", cwd)).toBe(cwd);
	});

	// --- Cases that MUST return null --------------------------------------

	it("returns null when the edited file is ABOVE harnessCwd", () => {
		const parent = makeTmp("interlinked-projroot-above-");
		writeFileSync(join(parent, "package.json"), JSON.stringify({ name: "parent" }));
		const cwd = join(parent, "child");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		// File lives in the parent — outside (above) harnessCwd.
		const file = join(parent, "outside.ts");
		writeFileSync(file, "export const o = 1;\n");

		expect(findProjectRoot(file, cwd)).toBeNull();
	});

	it("returns null when the edited file is in an unrelated sibling tree with its own package.json", () => {
		const base = makeTmp("interlinked-projroot-sibling-");
		const cwd = join(base, "project-a");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "project-a" }));

		const sibling = join(base, "project-b");
		mkdirSync(join(sibling, "src"), { recursive: true });
		writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: "project-b" }));
		const file = join(sibling, "src", "sib.ts");
		writeFileSync(file, "export const s = 1;\n");

		expect(findProjectRoot(file, cwd)).toBeNull();
	});

	it("returns null — never the shared ancestor — for the reported ~/package.json escape", () => {
		// Simulates the incident: harnessCwd is a real project, the edited
		// file is outside it, and a package.json sits in a shared ANCESTOR
		// of both (the stray `~/package.json`). Must NOT return the ancestor.
		const home = makeTmp("interlinked-projroot-home-");
		writeFileSync(join(home, "package.json"), JSON.stringify({ name: "stray-home-pkg" }));

		const cwd = join(home, "code", "interlinked-cli");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "interlinked-cli" }));
		writeFileSync(join(cwd, "tsconfig.json"), "{}");

		// Edited file is somewhere else under $HOME, outside harnessCwd.
		const foreign = join(home, "other-repo", "src");
		mkdirSync(foreign, { recursive: true });
		const file = join(foreign, "foreign.ts");
		writeFileSync(file, "export const f = 1;\n");

		expect(findProjectRoot(file, cwd)).toBeNull();
	});

	it("returns null when no marker exists anywhere within harnessCwd", () => {
		const cwd = makeTmp("interlinked-projroot-nomarker-");
		const file = join(cwd, "src", "lonely.ts");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(file, "export const l = 1;\n");

		expect(findProjectRoot(file, cwd)).toBeNull();
	});
});
