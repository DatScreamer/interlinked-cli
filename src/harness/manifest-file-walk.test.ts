import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findManifestFiles } from "./manifest-file-walk.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "walk-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("findManifestFiles", () => {
	it("finds nested matches and returns POSIX-relative paths", () => {
		mkdirSync(join(root, "src", "App"), { recursive: true });
		writeFileSync(join(root, "App.csproj"), "");
		writeFileSync(join(root, "src", "App", "App.csproj"), "");
		const found = findManifestFiles(root, (n) => n.endsWith(".csproj"));
		expect(found.sort()).toEqual(["App.csproj", "src/App/App.csproj"]);
	});

	it("skips ignored dirs (node_modules, bin)", () => {
		mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "node_modules", "pkg", "Vendored.csproj"), "");
		writeFileSync(join(root, "bin", "Built.csproj"), "");
		writeFileSync(join(root, "Real.csproj"), "");
		expect(findManifestFiles(root, (n) => n.endsWith(".csproj"))).toEqual(["Real.csproj"]);
	});

	it("skips tool-managed tree copies (.stryker-tmp sandboxes, .wrangler output)", () => {
		mkdirSync(join(root, ".stryker-tmp", "sandbox-abc", "src"), { recursive: true });
		mkdirSync(join(root, ".wrangler", "tmp"), { recursive: true });
		writeFileSync(join(root, ".stryker-tmp", "sandbox-abc", "src", "copy.ts"), "");
		writeFileSync(join(root, ".wrangler", "tmp", "bundle.ts"), "");
		writeFileSync(join(root, "real.ts"), "");
		expect(findManifestFiles(root, (n) => n.endsWith(".ts"))).toEqual(["real.ts"]);
	});

	it("does not traverse symlinked directories (no escape out of the tree)", () => {
		const outside = mkdtempSync(join(tmpdir(), "walk-outside-"));
		writeFileSync(join(outside, "Escaped.csproj"), "");
		try {
			symlinkSync(outside, join(root, "link"));
			expect(findManifestFiles(root, (n) => n.endsWith(".csproj"))).toEqual([]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("returns [] for an unreadable/missing root", () => {
		expect(findManifestFiles(join(root, "does-not-exist"), () => true)).toEqual([]);
	});
});
