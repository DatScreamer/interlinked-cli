import { describe, expect, it } from "vitest";
import { HOOK_SCRIPT_VERSION } from "../hook-version.js";

describe("HOOK_SCRIPT_VERSION", () => {
	it("resolves to a non-empty semver-ish string", () => {
		expect(typeof HOOK_SCRIPT_VERSION).toBe("string");
		expect(HOOK_SCRIPT_VERSION.length).toBeGreaterThan(0);
	});

	it("matches the version in cli/package.json (not a parent monorepo's)", async () => {
		// Regression test for the old `new URL("../../package.json", ...)`
		// approach, which resolved to the monorepo's package.json when the
		// CLI ran from `dist/`. The walk-up-and-match-by-name logic must
		// pick up *this* package specifically.
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const { dirname, join } = await import("node:path");
		const here = dirname(fileURLToPath(import.meta.url));
		// Walk from the test file up to the cli/ package root.
		const pkgPath = join(here, "..", "..", "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
			name?: string;
			version?: string;
		};
		expect(pkg.name).toBe("interlinked-cli");
		expect(HOOK_SCRIPT_VERSION).toBe(pkg.version);
	});

	it("is a valid-ish semver (major.minor.patch prefix)", () => {
		// Not a strict semver validator — just guards against the fallback
		// "0.0.0" sneaking in silently. A real CLI build should never be 0.0.0.
		expect(HOOK_SCRIPT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("does not resolve to the fallback on a healthy dev tree", () => {
		// Lives as its own test so a regression (fallback triggering) fails
		// obviously rather than silently passing the shape checks above.
		expect(HOOK_SCRIPT_VERSION).not.toBe("0.0.0");
	});
});
