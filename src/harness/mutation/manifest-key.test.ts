// Companion for manifest-key.ts — the extracted canonical-key choke point.
// The five-spellings/one-key defect class (measured 2026-07-31) is the pin:
// every spelling of one file must collapse to the same repo-relative key.

import { describe, expect, it } from "vitest";
import { normalizeManifestKey } from "./manifest-key.js";

const CWD = "/repo";

describe("normalizeManifestKey — positive (must collapse)", () => {
	// test-contract: invariant — one file, one manifest key, for every spelling a hook or sweep can produce
	it("P1: absolute, ./-prefixed, and plain relative spellings collapse to one key", () => {
		expect(normalizeManifestKey("/repo/src/a.ts", CWD)).toBe("src/a.ts");
		expect(normalizeManifestKey("./src/a.ts", CWD)).toBe("src/a.ts");
		expect(normalizeManifestKey("src/a.ts", CWD)).toBe("src/a.ts");
	});

	// test-contract: bug — the 2026-07-31 five-keys defect: //, /./ and /../ spellings each earned their own record
	it("P2: doubled, dotted, and parent-hop segments collapse via the resolve round-trip", () => {
		expect(normalizeManifestKey("src//a.ts", CWD)).toBe("src/a.ts");
		expect(normalizeManifestKey("src/./a.ts", CWD)).toBe("src/a.ts");
		expect(normalizeManifestKey("src/sub/../a.ts", CWD)).toBe("src/a.ts");
	});

	// test-contract: public-api — backslash input (Windows-shaped hook payloads) normalizes to forward slashes
	it("P3: backslash separators normalize to the same forward-slash key", () => {
		expect(normalizeManifestKey("src\\a.ts", CWD)).toBe("src/a.ts");
	});
});

describe("normalizeManifestKey — negative (must not conflate)", () => {
	// test-contract: invariant — distinct files must keep distinct keys; the choke point collapses spellings, not files
	it("N1: sibling files do not collapse onto each other", () => {
		expect(normalizeManifestKey("src/a.ts", CWD)).not.toBe(normalizeManifestKey("src/b.ts", CWD));
	});

	// test-contract: boundary — a path outside the cwd stays relative-with-parent-hops rather than losing its identity
	it("N2: an out-of-repo absolute path keeps its parent-hop identity", () => {
		expect(normalizeManifestKey("/elsewhere/x.ts", CWD)).toBe("../elsewhere/x.ts");
	});
});
