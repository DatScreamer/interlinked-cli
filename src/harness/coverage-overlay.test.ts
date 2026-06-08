import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoverageOverlay } from "./coverage-overlay.js";

let root: string;

beforeEach(() => {
	// realpathSync so the root matches the symlink-resolved overlayRoot the
	// factory returns (macOS tmpdir is /var → /private/var); the production
	// caller likewise passes a resolved cwd.
	root = realpathSync(mkdtempSync(join(tmpdir(), "interlinked-cov-overlay-")));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
	writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "src", "a.test.ts"), "// test\n");
	// node_modules should be linked, not copied.
	mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("createCoverageOverlay", () => {
	it("roots the overlay UNDER projectRoot (not os.tmpdir)", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(relative(root, overlay.overlayRoot).startsWith("..")).toBe(false);
		expect(overlay.overlayRoot.startsWith(root)).toBe(true);
		overlay.cleanup();
	});

	it("writes the proposed content for the edited file into the overlay", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const overlaidFile = join(overlay.overlayRoot, "src", "a.ts");
		expect(readFileSync(overlaidFile, "utf-8")).toBe("export const a = 2;\n");
		overlay.cleanup();
	});

	it("mirrors sibling source + test files so the suite sees the whole project", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(existsSync(join(overlay.overlayRoot, "src", "a.test.ts"))).toBe(true);
		expect(existsSync(join(overlay.overlayRoot, "package.json"))).toBe(true);
		overlay.cleanup();
	});

	it("links node_modules rather than deep-copying it", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const nm = join(overlay.overlayRoot, "node_modules");
		expect(existsSync(nm)).toBe(true);
		// A symlink keeps the mirror cheap; assert it's a link, not a real dir copy.
		expect(lstatSync(nm).isSymbolicLink()).toBe(true);
		overlay.cleanup();
	});

	it("supports a brand-new file not yet on disk (Write of a new module)", () => {
		const overlay = createCoverageOverlay(root, "src/brand-new.ts", "export const z = 9;\n");
		const overlaidFile = join(overlay.overlayRoot, "src", "brand-new.ts");
		expect(readFileSync(overlaidFile, "utf-8")).toBe("export const z = 9;\n");
		overlay.cleanup();
	});

	it("cleanup removes the overlay tree", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const overlayRoot = overlay.overlayRoot;
		expect(existsSync(overlayRoot)).toBe(true);
		overlay.cleanup();
		expect(existsSync(overlayRoot)).toBe(false);
	});

	it("does not recursively copy a previous overlay dir into the new one", () => {
		const first = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const second = createCoverageOverlay(root, "src/a.ts", "export const a = 3;\n");
		// The second overlay must not contain the first overlay nested inside it.
		const firstName = relative(dirname(first.overlayRoot), first.overlayRoot);
		expect(existsSync(join(second.overlayRoot, ".interlinked", firstName))).toBe(false);
		first.cleanup();
		second.cleanup();
	});
});
