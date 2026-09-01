// test-contract: security — local protocol-v3 inputs stay bound to the
// descriptor that was validated, even when their pathname changes mid-read.

import {
	appendFileSync,
	mkdtempSync,
	mkdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfinedFileBytes, readConfinedFileText } from "./mutation-cloud-v3-local-read.js";

let root = "";
let outsideRoot = "";

function fixturePath(name = "input.txt"): string {
	root = mkdtempSync(join(tmpdir(), "interlinked-v3-local-read-"));
	const path = join(root, name);
	mkdirSync(join(path, ".."), { recursive: true });
	return path;
}

function input(path: string, maxBytes = 64) {
	return { root, path, maxBytes, label: "protocol-v3 test input" };
}

afterEach(() => {
	if (root !== "") rmSync(root, { recursive: true, force: true });
	if (outsideRoot !== "") rmSync(outsideRoot, { recursive: true, force: true });
	root = "";
	outsideRoot = "";
});

describe("descriptor-bound local protocol-v3 reads", () => {
	it("reads a normal regular file exactly once through its bounded descriptor", () => {
		const path = fixturePath();
		writeFileSync(path, "exact bytes", "utf8");

		expect(readConfinedFileBytes(input(path))).toEqual(Buffer.from("exact bytes"));
		expect(readConfinedFileText(input(path))).toBe("exact bytes");
	});

	it("rejects a file whose descriptor reports more than the byte cap", () => {
		const path = fixturePath();
		writeFileSync(path, Buffer.alloc(65));

		expect(() => readConfinedFileBytes(input(path))).toThrow("64-byte local limit");
	});

	it("rejects a regular-file replacement between pathname validation and open", () => {
		const path = fixturePath();
		const original = `${path}.original`;
		const replacement = `${path}.replacement`;
		writeFileSync(path, "original", "utf8");
		writeFileSync(replacement, "replaced", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterPathValidated: () => {
				renameSync(path, original);
				renameSync(replacement, path);
			},
		})).toThrow("changed while it was being read");
	});

	it("rejects a final-component symlink swap after descriptor validation", () => {
		const path = fixturePath();
		const original = `${path}.original`;
		const other = `${path}.other`;
		writeFileSync(path, "original", "utf8");
		writeFileSync(other, "foreign", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterDescriptorValidated: () => {
				renameSync(path, original);
				symlinkSync(other, path);
			},
		})).toThrow("changed while it was being read");
	});

	it("rejects inode size drift after descriptor validation", () => {
		const path = fixturePath();
		writeFileSync(path, "original", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterDescriptorValidated: () => appendFileSync(path, "-changed", "utf8"),
		})).toThrow("changed while it was being read");
	});

	it("rechecks confinement when an intermediate directory symlink is swapped", () => {
		const path = fixturePath("inside/input.txt");
		const alias = join(root, "alias");
		outsideRoot = mkdtempSync(join(tmpdir(), "interlinked-v3-local-read-outside-"));
		writeFileSync(path, "inside", "utf8");
		writeFileSync(join(outsideRoot, "input.txt"), "outside", "utf8");
		symlinkSync(join(root, "inside"), alias);

		expect(() => readConfinedFileBytes(input(join(alias, "input.txt")), {
			afterDescriptorValidated: () => {
				unlinkSync(alias);
				symlinkSync(outsideRoot, alias);
			},
		})).toThrow("changed while it was being read");
	});
});
