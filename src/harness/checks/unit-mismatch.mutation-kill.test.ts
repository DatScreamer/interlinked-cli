// Mutation-kill tests for unit-mismatch.ts (timeout_unit_mismatch).
// Companion to unit-mismatch.test.ts — targets internal-helper survivors
// (isSecondsName, isMsName, extractDelayArg, lastSegment, classifyDelayArg)
// that are unexported, so every case reaches them only through the public
// detectTimeoutUnitMismatch(content, filePath) entry point.
//
// Pass-1 W6 kill campaign — decided_by "pass1_w21".
// Receipts: scratch/fleet-r3/receipts/src_harness_checks_unit-mismatch.ts.jsonl

import { describe, expect, it } from "vitest";
import { detectTimeoutUnitMismatch } from "./unit-mismatch.js";

function findings(src: string, path = "src/util.ts") {
	return detectTimeoutUnitMismatch(src, path);
}

function fires(src: string): boolean {
	return findings(src).length > 0;
}

// ─── isSecondsName (10 survivors) ──────────────────────────────────────────────

describe("isSecondsName — reached via the direct-identifier branch", () => {
	// test-contract: bug — the `/milli|msec/i` early-return-false guard must
	// still fire when the OR-chain (unmutated) would otherwise match; a name
	// containing "milli" that also ends in "_sec" proves the guard is load-bearing.
	it("kills the milli/msec guard removal (5a3bbc069557a13a)", () => {
		expect(fires("setTimeout(fn, milli_sec);")).toBe(false);
	});

	// test-contract: boundary — de-anchoring the leading `^` on /^sec(?:ond)?s?$/i
	// would let a name merely ENDING in "sec" match; "nsec" ends in "sec" but is
	// not the whole-word "sec".
	it("kills the ^sec(?:ond)?s?$ leading-anchor removal (c83724b78eaffca8)", () => {
		expect(fires("setTimeout(fn, nsec);")).toBe(false);
	});

	// test-contract: boundary — de-anchoring the trailing `$` would let a name
	// merely STARTING with "sec" match; "secretKey" starts with "sec" but isn't
	// the whole-word "sec".
	it("kills the ^sec(?:ond)?s?$ trailing-anchor removal (11fd7d0ffc6d04cb)", () => {
		expect(fires("setTimeout(fn, secretKey);")).toBe(false);
	});

	// test-contract: boundary — bare whole-word "sec" (no "ond", no trailing "s")
	// must fire per the documented "whole-word sec/secs/seconds" rule; this input
	// requires BOTH optional groups to be genuinely optional.
	it("kills mandatory-'ond' and mandatory-'s' regex mutants (5531d85eca084ff6, f1863b77d8f5413d)", () => {
		expect(fires("setTimeout(fn, sec);")).toBe(true);
	});

	// test-contract: boundary — de-anchoring the trailing `$` on /_s$/ would let
	// "_s" appearing ANYWHERE match; "retry_stuff" contains "_s" mid-string but
	// does not END in "_s".
	it("kills the _s$ trailing-anchor removal (18164ed518b6a595)", () => {
		expect(fires("setTimeout(fn, retry_stuff);")).toBe(false);
	});

	// test-contract: boundary — de-anchoring the trailing `$` on /_sec(?:ond)?s?$/i
	// would let "_sec" appearing ANYWHERE match; "my_sectional" contains "_sec"
	// mid-string but does not END there.
	it("kills the _sec(?:ond)?s?$ trailing-anchor removal (157ae9128db1b1e7)", () => {
		expect(fires("setTimeout(fn, my_sectional);")).toBe(false);
	});

	// test-contract: boundary — "_sec" with no "ond" and no trailing "s" must
	// still fire per the same optional-groups rule as the bare "sec" case above,
	// this time for the underscore-prefixed pattern.
	it("kills mandatory-'ond' and mandatory-'s' on _sec(?:ond)?s?$ (66eec9d6aea96a97, 446d74795275d32f)", () => {
		expect(fires("setTimeout(fn, retry_sec);")).toBe(true);
	});

	// test-contract: boundary — de-anchoring the trailing `$` on the case-sensitive
	// /(?:Sec|Second)s?$/ would let "Sec" appearing ANYWHERE (case-sensitive)
	// match; "Section" starts with capital "Sec" but does not END there.
	it("kills the (?:Sec|Second)s?$ trailing-anchor removal (d9149a5d908b695e)", () => {
		expect(fires("setTimeout(fn, Section);")).toBe(false);
	});
});

// ─── isMsName (6 survivors) ─────────────────────────────────────────────────────

describe("isMsName — reached via the inverse (*1000) branch", () => {
	// test-contract: bug — forcing the `/^ms$/i || /_ms$/i` sub-expression to
	// `false` (or to `&&`) removes the ability to match bare "ms"; neither the
	// case-sensitive /Ms$/ nor /milli.../i clause can pick up bare "ms" on its own.
	it("kills the ^ms$/_ms$ OR-clause force-false and OR-to-AND mutants (e05f8ce6ddbfd7d8, bfe53bfb73099e2a)", () => {
		expect(fires("setTimeout(fn, ms * 1000);")).toBe(true);
	});

	// test-contract: boundary — de-anchoring the trailing `$` on /^ms$/i would
	// let any name STARTING with "ms" match; "msFoo" starts with "ms" but is not
	// exactly "ms".
	it("kills the ^ms$ trailing-anchor removal (b6db504aa6785a51)", () => {
		expect(fires("setTimeout(fn, msFoo * 1000);")).toBe(false);
	});

	// test-contract: boundary — de-anchoring the trailing `$` on /_ms$/i would
	// let "_ms" appearing ANYWHERE match; "x_msValue" contains "_ms" mid-string
	// but does not END there.
	it("kills the _ms$ trailing-anchor removal (e679bd2cc72ec953)", () => {
		expect(fires("setTimeout(fn, x_msValue * 1000);")).toBe(false);
	});

	// test-contract: boundary — de-anchoring the trailing `$` on the
	// case-sensitive /Ms$/ would let "Ms" appearing ANYWHERE match; "MsgQueue"
	// starts with capital "Ms" but does not END there.
	it("kills the Ms$ trailing-anchor removal (70000f3a2a6d98aa)", () => {
		expect(fires("setTimeout(fn, MsgQueue * 1000);")).toBe(false);
	});

	// test-contract: boundary — de-anchoring the trailing `$` on
	// /milli(?:s|seconds)$/i would let "millis" appearing ANYWHERE match;
	// "millisFoo" starts with "millis" but does not END there.
	it("kills the milli(?:s|seconds)$ trailing-anchor removal (55cdb4bf21aa5b82)", () => {
		expect(fires("setTimeout(fn, millisFoo * 1000);")).toBe(false);
	});
});

// ─── extractDelayArg (11 survivors: 8 killed, 3 equivalent) ───────────────────

describe("extractDelayArg — scan-window boundary and bracket/comma balancing", () => {
	// test-contract: boundary — the scan window must EXCLUDE the char at exactly
	// `afterParen + ARG_SCAN_WINDOW` (Math.min, `i < end` not `i <= end`): a
	// closing paren sitting precisely on that boundary must read as out-of-window.
	it("kills the scan-window Math.min→Math.max and i<end→i<=end mutants (da4c74a32112fe38, 5ed1533ee9dd5bf5)", () => {
		const ARG_SCAN_WINDOW = 1500; // mirrors the unexported source constant
		const prefix = "setTimeout(fn, delaySeconds";
		const afterParen = "setTimeout(".length;
		const end = afterParen + ARG_SCAN_WINDOW;
		const padLen = end - prefix.length;
		expect(padLen).toBeGreaterThan(0);
		const src = `${prefix}${" ".repeat(padLen)});`;
		// Self-check the construction: ')' really sits at absolute offset `end`.
		expect(src.indexOf(")")).toBe(end);
		expect(fires(src)).toBe(false);
	});

	// test-contract: bug — `[` must increment depth (StringLiteral "" and
	// ConditionalExpression false both disable it); without that, a `]` inside
	// the callback argument falsely closes the call before the real comma is
	// ever reached, silently swallowing a genuine seconds-named delay arg.
	it("kills the '[' depth-increment removal mutants (f34f01d08a5195a6, b63a57be4453e603)", () => {
		expect(fires("setTimeout(cb[0], delaySeconds);")).toBe(true);
	});

	// test-contract: bug — `]` must decrement depth (StringLiteral "" and
	// ConditionalExpression false both disable it); without that, a `[...]`
	// pair in the callback arg inflates depth permanently, hiding the finding.
	it("kills the ']' depth-decrement removal mutants (e3a57d4340794ad1, 55cae8ea5730d7b8)", () => {
		expect(fires("setTimeout([a], delaySeconds);")).toBe(true);
	});

	// test-contract: bug — forcing `depth === 1` to `true` in the comma check
	// makes an INNER call's own comma (at depth 2) count as the top-level
	// delay-arg separator, corrupting the extracted text with leftover
	// callback-argument punctuation.
	it("kills the depth===1 comma-guard force-true mutant (63f5b5da324da656)", () => {
		expect(fires("setTimeout(fn(a, b), delaySeconds);")).toBe(true);
	});

	// test-contract: bug — forcing `commaCount === 1` to `true` makes the
	// function keep resetting argStart on EVERY top-level comma instead of
	// stopping at the second one, so a 3-argument call reads the THIRD
	// positional arg as the delay instead of correctly stopping at the second.
	it("kills the commaCount===1 force-true mutant (800bffd85cce1c23)", () => {
		expect(fires("setTimeout(fn, extraCallbackArg, delaySeconds);")).toBe(false);
	});
});

// Suspected-equivalent survivors (no test — structural proof only, see
// receipts for the full one-line argument each):
//   4748bafe82c278a9 — argStart init -1 -> +1: only observable when no
//     top-level comma is ever found, and in that case the returned slice
//     always contains this SAME call's own opening paren (afterParen-1 is
//     always between the sentinel and closeIdx, since "setTimeout("/
//     "setInterval(" is >=11 chars), which fails DOTTED_IDENT_RE and the
//     mul regex identically to arg===null downstream.
//   ca1aed676ebbf973 — `argStart >= 0` forced `true`: the only case this
//     changes is argStart===-1 (never reassigned), and
//     `stripped.slice(-1, closeIdx)` is ALWAYS "" (negative start resolves
//     to length-1, which is always >= any valid closeIdx), so
//     classifyDelayArg("") === null either way.
//   bcd49724ac7b8fc1 — `argStart >= 0` -> `argStart > 0`: argStart is only
//     ever -1 (sentinel) or i+1 for a comma found at i >= afterParen >= 11,
//     i.e. always >= 12; it can never equal exactly 0, so >= 0 and > 0
//     agree on every reachable value.

// ─── lastSegment (1 survivor) ───────────────────────────────────────────────────

describe("lastSegment — dotted-path last-segment resolution", () => {
	// test-contract: bug — `?? path` → `&& path` makes lastSegment return the
	// WHOLE dotted path, not just the final segment. A path whose PREFIX trips
	// the milli/msec guard but whose LAST SEGMENT alone is seconds-named tells them apart.
	it("kills the ?? -> && operator mutant (7eca8d36cac6f004)", () => {
		expect(fires("setTimeout(fn, milliOpts.delaySeconds);")).toBe(true);
	});
});

// ─── classifyDelayArg (19 survivors) ────────────────────────────────────────────

describe("classifyDelayArg — exact message text", () => {
	// test-contract: public-api — the finding's `text` field is the check's
	// whole visible payload; an exact match kills the StringLiteral message
	// mutant plus (rawText plumbing feeds this string) split('\n')->split('') and `??`->`&&`.
	it("kills the seconds-message template + split('\\n') + rawLines ?? mutants (acd1fc675d252c6a, 9c66f7b30d54080e, 0598668cb3c32212)", () => {
		const src = "setTimeout(fn, delaySeconds);";
		expect(findings(src)).toEqual([
			{
				line: 1,
				text:
					'timeout_unit_mismatch: seconds-named value "delaySeconds" passed directly as the delay — setTimeout/setInterval expect milliseconds (multiply by 1000) — setTimeout(fn, delaySeconds);',
			},
		]);
	});

	// test-contract: public-api — same rationale as above, for the inverse
	// (ms * 1000) message template.
	it("kills the ms-message template mutant (8b9f1b30120e7711)", () => {
		const src = "setTimeout(fn, delayMs * 1000);";
		expect(findings(src)).toEqual([
			{
				line: 1,
				text:
					'timeout_unit_mismatch: milliseconds-named value "delayMs" multiplied by 1000 at the call site — the delay is already in ms (drop the * 1000) — setTimeout(fn, delayMs * 1000);',
			},
		]);
	});
});

describe("classifyDelayArg — IDENT * 1000 regex boundary mutants", () => {
	// test-contract: boundary — de-anchoring the leading `^` lets a garbage
	// prefix precede the real "ident * 1000" match; "2 * delayMs * 1000" is not
	// itself a whole-string match, so it must NOT fire.
	it("kills the leading-anchor removal on IDENT*1000 (031e6c9b70a5bbc7)", () => {
		expect(fires("setTimeout(fn, 2 * delayMs * 1000);")).toBe(false);
	});

	// test-contract: boundary — de-anchoring the trailing `$` lets trailing
	// garbage follow a valid "ident * 1000" prefix; it must NOT fire since the
	// whole extracted arg is not exactly "ident * 1000".
	it("kills the trailing-anchor removal on IDENT*1000 (2b43968a8849e1d7)", () => {
		expect(fires("setTimeout(fn, delayMs * 1000 + buffer);")).toBe(false);
	});

	// test-contract: boundary — negating/truncating the dotted-continuation
	// character classes breaks matching a genuinely dotted identifier
	// ("opts.delayMs"); all four mutants share this one failure mode.
	it("kills the dotted-continuation char-class mutants on IDENT*1000 (e67eb3ef231c39bf, d27174d7f63564eb, 37c3967f83cf826f, 52be4d16265d6489)", () => {
		expect(fires("setTimeout(fn, opts.delayMs * 1000);")).toBe(true);
	});

	// test-contract: boundary — turning either optional `\s*` around the `*`
	// into a mandatory `\s` breaks the zero-space form "delayMs*1000"; both
	// mutants share this failure mode.
	it("kills the mandatory-whitespace mutants around * on IDENT*1000 (1e3b401db738e0ba, 6f960d37122fb00b)", () => {
		expect(fires("setTimeout(fn, delayMs*1000);")).toBe(true);
	});
});

describe("classifyDelayArg — 1000 * IDENT regex boundary mutants", () => {
	// test-contract: boundary — de-anchoring the leading `^` lets a garbage
	// prefix precede the real "1000 * ident" match.
	it("kills the leading-anchor removal on 1000*IDENT (dac0068b0f3ab92a)", () => {
		expect(fires("setTimeout(fn, base + 1000 * delayMs);")).toBe(false);
	});

	// test-contract: boundary — de-anchoring the trailing `$` lets trailing
	// garbage follow a valid "1000 * ident" prefix.
	it("kills the trailing-anchor removal on 1000*IDENT (ca534aafbbbbb6cd)", () => {
		expect(fires("setTimeout(fn, 1000 * delayMs + buffer);")).toBe(false);
	});

	// test-contract: boundary — turning either optional `\s*` (after "1000",
	// or after `*`) into a mandatory `\s` breaks the zero-space form
	// "1000*delayMs"; both mutants share this failure mode.
	it("kills the mandatory-whitespace mutants around * on 1000*IDENT (2b5e44da92623ea4, db8e409d8eaccd81)", () => {
		expect(fires("setTimeout(fn, 1000*delayMs);")).toBe(true);
	});

	// test-contract: boundary — negating the identifier's OWN first-char class
	// makes it impossible to capture any real identifier at all.
	it("kills the ident first-char-class negation on 1000*IDENT (6340f04bfc657003)", () => {
		expect(fires("setTimeout(fn, 1000 * delayMs);")).toBe(true);
	});

	// test-contract: boundary — negating/truncating the dotted-continuation
	// character classes breaks matching a genuinely dotted identifier
	// ("opts.delayMs"); all four mutants share this one failure mode.
	it("kills the dotted-continuation char-class mutants on 1000*IDENT (4b0eca4e5edd6599, 49d717859dd2fb36, 76d7983b35665254, 599631640964005f)", () => {
		expect(fires("setTimeout(fn, 1000 * opts.delayMs);")).toBe(true);
	});
});

// ─── detectTimeoutUnitMismatch (9 survivors) ────────────────────────────────────

describe("detectTimeoutUnitMismatch — cap, dedup, and rawText formatting", () => {
	// test-contract: invariant — MAX_MATCHES_PER_FILE (10) must cap the number
	// of findings per file; an exact count of 10 (not 11 or 12) kills both the
	// force-false cap-check removal and the >= -> > off-by-one.
	it("kills the MAX_MATCHES_PER_FILE cap-removal and off-by-one mutants (0f075294264226ca, 9372a415345b1e0c)", () => {
		const src = Array.from({ length: 12 }, () => "setTimeout(fn, delaySeconds);").join("\n");
		expect(findings(src).length).toBe(10);
	});

	// test-contract: invariant — a timer call with only one argument (no delay
	// arg at all) must be silently skipped, not throw; forcing the
	// `arg === null` guard to `false` reaches `arg.text` on a null value.
	it("kills the arg===null skip-guard removal (2d0121e0f13b90e7)", () => {
		const src = "setTimeout(fn);";
		expect(() => findings(src)).not.toThrow();
		expect(findings(src)).toEqual([]);
	});

	// test-contract: invariant — two separate mismatched calls on the SAME
	// line must be reported once (dedup by line), not twice; forcing
	// `seen.has(lineNo)` to `false` disables the dedup.
	it("kills the seen-line dedup removal (f8ed916ccf1968da)", () => {
		const src = "setTimeout(fn, delaySeconds); setInterval(fn2, timeoutSec);";
		expect(findings(src).length).toBe(1);
	});

	// test-contract: boundary — a line longer than REPORT_LINE_TRUNC (150)
	// chars must be truncated in the reported text; removing `.slice(0, 150)`
	// leaves the full untruncated line instead.
	it("kills the REPORT_LINE_TRUNC slice removal (28627161506f8327)", () => {
		const REPORT_LINE_TRUNC = 150; // mirrors the unexported source constant
		const rawLine = `setTimeout(fn, delaySeconds); // ${"x".repeat(200)}`;
		const out = findings(rawLine);
		expect(out.length).toBe(1);
		const expectedRawText = rawLine.trim().slice(0, REPORT_LINE_TRUNC);
		expect(out[0]?.text).toBe(
			`timeout_unit_mismatch: seconds-named value "delaySeconds" passed directly as the delay — setTimeout/setInterval expect milliseconds (multiply by 1000) — ${expectedRawText}`,
		);
	});

	// test-contract: boundary — leading whitespace on the source line must be
	// trimmed out of the reported rawText; removing `.trim()` leaves it in.
	it("kills the rawText .trim() removal (9c1d4675cd48cfa8)", () => {
		const src = "    setTimeout(fn, delaySeconds);";
		expect(findings(src)).toEqual([
			{
				line: 1,
				text:
					'timeout_unit_mismatch: seconds-named value "delaySeconds" passed directly as the delay — setTimeout/setInterval expect milliseconds (multiply by 1000) — setTimeout(fn, delaySeconds);',
			},
		]);
	});

	// test-contract: boundary — `lineNo - 1` must index the SAME line the
	// match was found on; `lineNo + 1` (off-by-two vs. the correct 0-based
	// index) would instead grab a line two lines further down.
	it("kills the lineNo-1 -> lineNo+1 indexing mutant (14db17f814fcc192)", () => {
		const src = [
			"setTimeout(fn, delaySeconds);",
			"// line two placeholder",
			"// line three placeholder",
		].join("\n");
		const out = findings(src);
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(1);
		expect(out[0]?.text).toBe(
			'timeout_unit_mismatch: seconds-named value "delaySeconds" passed directly as the delay — setTimeout/setInterval expect milliseconds (multiply by 1000) — setTimeout(fn, delaySeconds);',
		);
	});
});
