import { describe, expect, it, vi } from "vitest";
import { evaluateMutation } from "./evaluate.js";
import type { MutationManifest } from "./types.js";

// With the optional `typescript` dep absent, identity derivation returns null and
// the evaluator degrades to a not-measured outcome (never a forged clean pass).
vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: () => () => {
			throw new Error("typescript not installed");
		},
	};
});

const BASE: MutationManifest = {
	version: 1,
	generation: 0,
	authoritativeAt: "t",
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	files: {},
};

describe("evaluateMutation without the optional typescript dep", () => {
	it("returns a not-measured outcome instead of crashing", () => {
		const out = evaluateMutation({
			file: "a.ts",
			baseManifest: BASE,
			overlayContent: "const x = 1;",
			adapted: [],
			siteCountThreshold: 50,
			at: "t",
		});
		expect(out.kind).toBe("unavailable");
	});
});
