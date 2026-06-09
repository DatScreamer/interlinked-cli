import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { symlinkInTree, writeFileInTree } from "./overlay-safe-write.js";

// SYMLINK-ESCAPE CONTRACT (findings 2026-06: overlay + snapshot data corruption). A
// repo can contain symlinked files or directories; a naive writeFileSync /
// copyFileSync FOLLOWS them and modifies the real target OUTSIDE the temp tree — data
// corruption during a read-only gate. Every overlay/snapshot write must stay inside
// the tree root, never touching an external symlink target.

let base: string;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "safe-write-"));
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("writeFileInTree — never follows a symlink out of the tree", () => {
	it("does NOT follow a symlinked FILE target", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const external = join(base, "real.txt");
		writeFileSync(external, "ORIGINAL", "utf-8");
		symlinkSync(external, join(root, "link.ts")); // tree/link.ts → ../real.txt

		writeFileInTree(root, "link.ts", "NEW");

		expect(readFileSync(external, "utf-8")).toBe("ORIGINAL"); // external file untouched
		expect(lstatSync(join(root, "link.ts")).isSymbolicLink()).toBe(false); // now a real file
		expect(readFileSync(join(root, "link.ts"), "utf-8")).toBe("NEW");
	});

	it("does NOT follow a symlinked DIRECTORY in the parent path", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const externalDir = join(base, "ext");
		mkdirSync(externalDir);
		writeFileSync(join(externalDir, "m.ts"), "ORIGINAL", "utf-8");
		symlinkSync(externalDir, join(root, "src"), "dir"); // tree/src → ../ext

		writeFileInTree(root, "src/m.ts", "NEW");

		expect(readFileSync(join(externalDir, "m.ts"), "utf-8")).toBe("ORIGINAL"); // untouched
		expect(lstatSync(join(root, "src")).isSymbolicLink()).toBe(false); // now a real dir
		expect(readFileSync(join(root, "src/m.ts"), "utf-8")).toBe("NEW");
	});
});

describe("symlinkInTree — updates a snapshot symlink without corrupting the old target", () => {
	it("recreates the link to a NEW target without overwriting the OLD target's contents", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const oldTarget = join(base, "old.txt");
		writeFileSync(oldTarget, "OLD", "utf-8");
		const newTarget = join(base, "new.txt");
		writeFileSync(newTarget, "NEW", "utf-8");
		symlinkSync(oldTarget, join(root, "link")); // existing snapshot symlink (the -a case)

		symlinkInTree(root, "link", newTarget);

		expect(readFileSync(oldTarget, "utf-8")).toBe("OLD"); // OLD external target untouched
		expect(lstatSync(join(root, "link")).isSymbolicLink()).toBe(true); // still a symlink
		expect(readlinkSync(join(root, "link"))).toBe(newTarget); // now points at NEW
	});
});
