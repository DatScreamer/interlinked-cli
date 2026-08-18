// Mutation-survivor kill tests for shared-text-utils-brace-scan.ts — PASS-1,
// wave W18 (scratch/fleet-r3/CONTRACT-W6.md, LEAN MODE). This file targets
// the 4 of ~20 assigned survivors that a full pristine-behavior audit showed
// are genuinely killable; the other 16 are suspected_equivalent, recorded
// with structural arguments in scratch/fleet-r3/receipts/
// src_harness_checks_shared-text-utils-brace-scan.ts.jsonl (decided_by:
// "pass1_w18"). Every expected string below was computed by running the
// real pristine stripForBraceScan, never hand-derived — see
// scratch/fleet-r3/probes/brace-scan-pristine-probe.mts.
import { describe, expect, it } from "vitest";
import { stripForBraceScan } from "./shared-text-utils-brace-scan.js";

describe("stripForBraceScan — isRegexStart must key off the scanner's own prevChar, not force the identifier branch", () => {
	// test-contract: invariant — isRegexStart's identifier check must read the
	// SCANNER's semantic prevChar, not force the precedingWord branch, which
	// would walk RAW content back through an already-scanned line comment and
	// pick up a stray regex-preceder keyword sitting inside it.
	it("P: a real closing brace keeps a later slash as division even when a stale line comment further back spells a regex-preceder keyword", () => {
		expect(stripForBraceScan("}//return\n/{}/")).toBe("}        \n/{}/");
	});
});

describe("stripForBraceScan — stepBlock's close-branch return value must carry a real step object", () => {
	// test-contract: invariant — every step handler's return value feeds
	// `i = step.i` in the driving loop; a malformed return makes i become
	// undefined, so `i < n` fails forever and the scan stops dead right after
	// the comment closes, leaving the trailing string un-scanned.
	it("P: a block comment closing normally must not stall the scan — trailing content is still processed", () => {
		expect(stripForBraceScan('/*c*/ "s"')).toBe("         ");
	});
});

describe("stripForBraceScan — stepCodeBrace's interpolation-close prevChar must stay the value marker, not go empty", () => {
	// test-contract: invariant — "" is itself a REGEX_PRECEDER_CHARS member, so
	// an interpolation-close prevChar of "" would treat the next `/` as an
	// unconditional regex-start instead of routing through precedingWord,
	// which correctly finds no preceder word here.
	it("P: a second interpolation opened right after the first closes must still resolve a leading slash through precedingWord, not skip straight to regex via an empty-prevChar preceder-char match", () => {
		expect(stripForBraceScan("`${1}${/y/}`")).toBe("   1   /y/  ");
	});
});

describe("stripForBraceScan — stepCodeOpener's line-comment return value must carry a real step object", () => {
	// test-contract: invariant — same class as stepBlock's return-object
	// contract above, on the `//` line-comment exit path: a malformed return
	// makes i undefined, so the scan stops dead at the newline and the
	// trailing string is left raw (unblanked) instead of processed.
	it("P: a line comment ending at a real newline must not stall the scan — trailing content is still processed", () => {
		expect(stripForBraceScan('//c\n"s"')).toBe('   \n   ');
	});
});
