// The Bun-regression corpus as a permanent false-negative calibration set
// (docs/external-pulse/bun-in-rust.md, docs/design/bun-regression-detectors.md §7).
// All four porting regressions Bun actually shipped passed this harness as
// committed at HEAD on 2026-07-09 — 4-of-4 missed. These fixtures pin the
// detectors that close each one, cross-asserted so no detector fires on a
// sibling's fixture: real bugs from a real port, not synthetic taste.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlaceholderRuntimeConstant } from "./placeholder-constants.js";
import { checkRegexFromInterpolation } from "./regex-interpolation.js";
import { checkRustUncheckedCastSlice } from "./reinterpret-alignment.js";
import { checkRustDebugAssertSideEffects } from "./ubs-language-specific/rust-go-checks.js";

const DIR = join(__dirname, "__fixtures__", "bun-regressions");
// Fixture CONTENT is what matters; detectors gate on extension + non-test
// paths, so each fixture is presented as ordinary source.
const asRust = "src/lib.rs";
const asJs = "src/output.mjs";

const fixtures = {
	debugAssert: readFileSync(join(DIR, "debug-assert-side-effect.rs"), "utf8"),
	castSlice: readFileSync(join(DIR, "cast-slice-odd-length.rs"), "utf8"),
	bssPlaceholder: readFileSync(join(DIR, "bss-placeholder-constant.rs"), "utf8"),
	formatMarker: readFileSync(join(DIR, "format-marker-interpolation.mjs"), "utf8"),
};

describe("Bun regression corpus — each detector catches its bug", () => {
	it("#30678 debug_assert side effect → ubs_rust_debug_assert_side_effect", () => {
		expect(checkRustDebugAssertSideEffects(fixtures.debugAssert, asRust)).toHaveLength(1);
	});

	it("#31188 odd-length cast_slice → ubs_rust_unchecked_cast_slice", () => {
		expect(checkRustUncheckedCastSlice(fixtures.castSlice, asRust).length).toBeGreaterThan(0);
	});

	it("#31503 confessing placeholder constant → placeholder_runtime_constant", () => {
		const hits = checkPlaceholderRuntimeConstant(fixtures.bssPlaceholder, asRust);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.text).toContain("BSS_OVERFLOW_BLOCK_SIZE");
	});

	it("#30693 interpolate-then-parse → regex_from_interpolation", () => {
		expect(checkRegexFromInterpolation(fixtures.formatMarker, asJs).length).toBeGreaterThan(0);
	});
});

describe("Bun regression corpus — no detector fires on a sibling's fixture", () => {
	it("debug-assert detector is silent on the other Rust fixtures", () => {
		expect(checkRustDebugAssertSideEffects(fixtures.castSlice, asRust)).toEqual([]);
		expect(checkRustDebugAssertSideEffects(fixtures.bssPlaceholder, asRust)).toEqual([]);
	});

	it("cast-slice detector is silent on the other Rust fixtures", () => {
		expect(checkRustUncheckedCastSlice(fixtures.debugAssert, asRust)).toEqual([]);
		expect(checkRustUncheckedCastSlice(fixtures.bssPlaceholder, asRust)).toEqual([]);
	});

	it("placeholder detector is silent on fixtures whose comments confess nothing", () => {
		expect(checkPlaceholderRuntimeConstant(fixtures.debugAssert, asRust)).toEqual([]);
		expect(checkPlaceholderRuntimeConstant(fixtures.castSlice, asRust)).toEqual([]);
	});

	it("regex detector is silent on the Rust fixtures (wrong language)", () => {
		expect(checkRegexFromInterpolation(fixtures.debugAssert, asRust)).toEqual([]);
	});
});
