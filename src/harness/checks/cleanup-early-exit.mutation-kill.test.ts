// Survivor-kill tests for src/harness/checks/cleanup-early-exit.ts, sourced
// from scratch/fleet-r2/kill-briefs/src_harness_checks_cleanup-early-exit.ts.json
// (154 surviving mutants).
//
// Every fixture in this file was cross-checked against the REAL (unmutated)
// source via scratch/probes/validate-rows.mts,
// scratch/probes/build-shape-batteries.mts, and
// scratch/probes/validate-remaining-fixtures.mts before being copied here,
// and the module-scope regex mutants were additionally verified one-by-one
// via scratch/probes/cleanup-early-exit-regex-matrix.mjs (orig regex matches
// the fixture line, the mutant regex does not).
//
// Two recurring techniques:
//   - "shape battery" tests: the 9 NAMED_ACQUISITIONS regexes
//     (`\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*<keyword>\s*\(`)
//     were mutated at every `\s+`/`\s*`/`\w+`/`(?:...)?` boundary. A single
//     declaration line using ordinary single-space formatting can't
//     distinguish `\s+` from `\s`, or `\s*` from `\S*`, etc. — both match
//     identically when there's exactly one space. Each "shape" below is an
//     edge-case declaration format (two spaces, zero optional whitespace, a
//     type annotation with space trapped on one side only, a space before
//     the call's opening paren, a bare/prefixed receiver) chosen so the
//     mutant's regex fails to match while the original still does. All 9
//     keywords are combined into ONE function body per shape (each acquires
//     its own uniquely-named resource with its own early-exit + cleanup),
//     so a single mutated keyword's regex failing to match drops
//     `out.length` by exactly 1 — proven independent per-keyword via the
//     regex-matrix probe, and cross-checked for the combined fixtures too.
//   - "exact line/text" assertions: many recordExit mutants (dropped
//     `.trim()`, `||` -> `&&`, `lineNo-1` -> `lineNo+1`, the whole object
//     literal replaced with `{}`, offset-arithmetic sign flips) are
//     invisible to a loose `toBeGreaterThanOrEqual(1)` check — the finding
//     still fires, just with a corrupted `line`/`text`. Asserting the exact
//     `{ line, text }` shape catches all of them at once.
import { describe, expect, it } from "vitest";
import { checkCleanupSkippedOnEarlyExit } from "./cleanup-early-exit.js";

const TS = "src/lib/foo.ts";

describe("checkCleanupSkippedOnEarlyExit — acquisition-regex shape robustness, positive cases (must fire)", () => {
	// Kills the first `\s+` (after const|let|var) -> `\s` replacement for
	// EVERY keyword (setInterval/setTimeout/subscribe/openSync/
	// createReadStream/createWriteStream/connect|createConnection/
	// createSocket/spawn|fork) — two literal spaces can't be matched by a
	// single mandatory `\s`. Also kills the `(?:\w\.)?`/`(?:\W+\.)?` prefix
	// character-class mutants for openSync/createReadStream/
	// createWriteStream/connect/createSocket, since their natural receiver
	// ("fs"/"net"/"dgram") is already 2+ word chars.
	it("P: all 9 acquisition keywords still match with two spaces after const/let/var", () => {
		const code = [
			"function bug() {",
			"  const  v1 = setInterval(fn, 1);",
			"  if (cond1) throw new Error('bad1');",
			"  clearInterval(v1);",
			"",
			"  const  v2 = setTimeout(fn, 1);",
			"  if (cond2) throw new Error('bad2');",
			"  clearTimeout(v2);",
			"",
			"  const  v3 = stream.subscribe(fn);",
			"  if (cond3) throw new Error('bad3');",
			"  v3.unsubscribe();",
			"",
			"  const  v4 = fs.openSync('a', 'r');",
			"  if (cond4) throw new Error('bad4');",
			"  fs.closeSync(v4);",
			"",
			"  const  v5 = fs.createReadStream('a');",
			"  if (cond5) throw new Error('bad5');",
			"  v5.close();",
			"",
			"  const  v6 = fs.createWriteStream('a');",
			"  if (cond6) throw new Error('bad6');",
			"  v6.end();",
			"",
			"  const  v7 = net.connect(1234, host);",
			"  if (cond7) throw new Error('bad7');",
			"  v7.destroy();",
			"",
			"  const  v8 = dgram.createSocket('udp4');",
			"  if (cond8) throw new Error('bad8');",
			"  v8.close();",
			"",
			"  const  v9 = spawn('ls');",
			"  if (cond9) throw new Error('bad9');",
			"  v9.kill();",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS).length).toBe(9);
	});

	// Kills the `(\w+)\s*(?:` -> `(\w+)\s(?:` (star dropped) and the
	// `\s*=` -> `\s=` / `=\s*` -> `=\s` (stars dropped around "=") replacements
	// for every keyword: zero optional whitespace anywhere means the
	// mutant's now-mandatory single `\s` has nothing to consume.
	it("P: all 9 acquisition keywords still match with zero optional whitespace", () => {
		const code = [
			"function bug() {",
			"  const v1=setInterval(fn, 1);",
			"  if (cond1) throw new Error('bad1');",
			"  clearInterval(v1);",
			"",
			"  const v2=setTimeout(fn, 1);",
			"  if (cond2) throw new Error('bad2');",
			"  clearTimeout(v2);",
			"",
			"  const v3=stream.subscribe(fn);",
			"  if (cond3) throw new Error('bad3');",
			"  v3.unsubscribe();",
			"",
			"  const v4=fs.openSync('a', 'r');",
			"  if (cond4) throw new Error('bad4');",
			"  fs.closeSync(v4);",
			"",
			"  const v5=fs.createReadStream('a');",
			"  if (cond5) throw new Error('bad5');",
			"  v5.close();",
			"",
			"  const v6=fs.createWriteStream('a');",
			"  if (cond6) throw new Error('bad6');",
			"  v6.end();",
			"",
			"  const v7=net.connect(1234, host);",
			"  if (cond7) throw new Error('bad7');",
			"  v7.destroy();",
			"",
			"  const v8=dgram.createSocket('udp4');",
			"  if (cond8) throw new Error('bad8');",
			"  v8.close();",
			"",
			"  const v9=spawn('ls');",
			"  if (cond9) throw new Error('bad9');",
			"  v9.kill();",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS).length).toBe(9);
	});

	// Kills the first `\s*` (after the capture group) -> `\S*` replacement
	// (a space trapped between the name and a following `:type` can only be
	// consumed by THIS `\s*`, since the trailing `\s*` before "=" starts
	// past the colon), plus the type-annotation-internal mutants
	// (`:\s*\w+` -> `:\s\w+` / `:\s*\w` / `:\s*\W+`, all needing zero space
	// AFTER the colon and a multi-char type name).
	it("P: all 9 acquisition keywords still match with a space-before-colon, tight-after type annotation", () => {
		const code = [
			"function bug() {",
			"  const v1 :Type=setInterval(fn, 1);",
			"  if (cond1) throw new Error('bad1');",
			"  clearInterval(v1);",
			"",
			"  const v2 :Type=setTimeout(fn, 1);",
			"  if (cond2) throw new Error('bad2');",
			"  clearTimeout(v2);",
			"",
			"  const v3 :Type=stream.subscribe(fn);",
			"  if (cond3) throw new Error('bad3');",
			"  v3.unsubscribe();",
			"",
			"  const v4 :Type=fs.openSync('a', 'r');",
			"  if (cond4) throw new Error('bad4');",
			"  fs.closeSync(v4);",
			"",
			"  const v5 :Type=fs.createReadStream('a');",
			"  if (cond5) throw new Error('bad5');",
			"  v5.close();",
			"",
			"  const v6 :Type=fs.createWriteStream('a');",
			"  if (cond6) throw new Error('bad6');",
			"  v6.end();",
			"",
			"  const v7 :Type=net.connect(1234, host);",
			"  if (cond7) throw new Error('bad7');",
			"  v7.destroy();",
			"",
			"  const v8 :Type=dgram.createSocket('udp4');",
			"  if (cond8) throw new Error('bad8');",
			"  v8.close();",
			"",
			"  const v9 :Type=spawn('ls');",
			"  if (cond9) throw new Error('bad9');",
			"  v9.kill();",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS).length).toBe(9);
	});

	// Kills the `:\s*\w+` -> `:\S*\w+` replacement (a space right after the
	// colon can't be consumed by `\S*`) and the `\s*` -> `\S*` right before
	// "=" (only reachable when a type annotation already used up the first
	// `\s*`, so this second one is the sole consumer of the space).
	it("P: all 9 acquisition keywords still match with a space after the type-annotation colon", () => {
		const code = [
			"function bug() {",
			"  const v1: Type = setInterval(fn, 1);",
			"  if (cond1) throw new Error('bad1');",
			"  clearInterval(v1);",
			"",
			"  const v2: Type = setTimeout(fn, 1);",
			"  if (cond2) throw new Error('bad2');",
			"  clearTimeout(v2);",
			"",
			"  const v3: Type = stream.subscribe(fn);",
			"  if (cond3) throw new Error('bad3');",
			"  v3.unsubscribe();",
			"",
			"  const v4: Type = fs.openSync('a', 'r');",
			"  if (cond4) throw new Error('bad4');",
			"  fs.closeSync(v4);",
			"",
			"  const v5: Type = fs.createReadStream('a');",
			"  if (cond5) throw new Error('bad5');",
			"  v5.close();",
			"",
			"  const v6: Type = fs.createWriteStream('a');",
			"  if (cond6) throw new Error('bad6');",
			"  v6.end();",
			"",
			"  const v7: Type = net.connect(1234, host);",
			"  if (cond7) throw new Error('bad7');",
			"  v7.destroy();",
			"",
			"  const v8: Type = dgram.createSocket('udp4');",
			"  if (cond8) throw new Error('bad8');",
			"  v8.close();",
			"",
			"  const v9: Type = spawn('ls');",
			"  if (cond9) throw new Error('bad9');",
			"  v9.kill();",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS).length).toBe(9);
	});

	// Kills the trailing `<keyword>\s*\(` -> `<keyword>\S*\(` replacement:
	// a literal space before the call's opening paren can't be matched by
	// `\S*`.
	it("P: all 9 acquisition keywords still match with a space before the call's opening paren", () => {
		const code = [
			"function bug() {",
			"  const v1 = setInterval (fn, 1);",
			"  if (cond1) throw new Error('bad1');",
			"  clearInterval(v1);",
			"",
			"  const v2 = setTimeout (fn, 1);",
			"  if (cond2) throw new Error('bad2');",
			"  clearTimeout(v2);",
			"",
			"  const v3 = stream.subscribe (fn);",
			"  if (cond3) throw new Error('bad3');",
			"  v3.unsubscribe();",
			"",
			"  const v4 = fs.openSync ('a', 'r');",
			"  if (cond4) throw new Error('bad4');",
			"  fs.closeSync(v4);",
			"",
			"  const v5 = fs.createReadStream ('a');",
			"  if (cond5) throw new Error('bad5');",
			"  v5.close();",
			"",
			"  const v6 = fs.createWriteStream ('a');",
			"  if (cond6) throw new Error('bad6');",
			"  v6.end();",
			"",
			"  const v7 = net.connect (1234, host);",
			"  if (cond7) throw new Error('bad7');",
			"  v7.destroy();",
			"",
			"  const v8 = dgram.createSocket ('udp4');",
			"  if (cond8) throw new Error('bad8');",
			"  v8.close();",
			"",
			"  const v9 = spawn ('ls');",
			"  if (cond9) throw new Error('bad9');",
			"  v9.kill();",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS).length).toBe(9);
	});

	// Kills the `(?:\w+\.)?` -> `(?:\w+\.)` replacement (optional prefix
	// made mandatory) for the 5 keywords that support a bare/destructured
	// form: `import { openSync } from 'node:fs'; openSync(...)` etc.
	it("P: openSync/createReadStream/createWriteStream/connect/createSocket still match with no receiver prefix", () => {
		const code = [
			"function bug() {",
			"  const v1 = openSync('a', 'r');",
			"  if (cond1) throw new Error('bad1');",
			"  fs.closeSync(v1);",
			"",
			"  const v2 = createReadStream('a');",
			"  if (cond2) throw new Error('bad2');",
			"  v2.close();",
			"",
			"  const v3 = createWriteStream('a');",
			"  if (cond3) throw new Error('bad3');",
			"  v3.end();",
			"",
			"  const v4 = connect(1234, host);",
			"  if (cond4) throw new Error('bad4');",
			"  v4.destroy();",
			"",
			"  const v5 = createSocket('udp4');",
			"  if (cond5) throw new Error('bad5');",
			"  v5.close();",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS).length).toBe(5);
	});

	// Kills the `(?:\w+\.)?` internal `\w+` -> `\w` / `\W+` replacements for
	// spawn|fork specifically: its natural call form (`spawn(...)`, no
	// receiver) doesn't exercise these, unlike the other 5 prefixed
	// keywords above whose natural receiver ("fs"/"net"/"dgram") is already
	// multi-char.
	it("P: spawn|fork still matches with a multi-char receiver prefix", () => {
		const code = [
			"function bug() {",
			"  const child = childProcessModule.spawn('ls');",
			"  if (cond) throw new Error('bad');",
			"  child.kill();",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS).length).toBe(1);
	});
});

describe("checkCleanupSkippedOnEarlyExit — cleanupReFor arrow functions, positive cases (must fire)", () => {
	// These two acquisition kinds (net.connect/createConnection and
	// dgram.createSocket) had NO existing coverage at all — the
	// `cleanupReFor: (n) => new RegExp(...)` arrow for each is a distinct
	// mutation site; `() => undefined` makes `window.match(undefined)`
	// match an empty string at index 0, so `between` is always "" and
	// `findEarlyExitOffset` always returns null (no finding, ever).
	it("P: flags net.connect acquisition with throw before .destroy()", () => {
		const code = [
			"function bug() {",
			"  const conn = net.connect(1234, remoteHost);",
			"  if (cond) throw new Error('bad');",
			"  conn.destroy();",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out).toEqual([{ line: 3, text: "if (cond) throw new Error('bad');" }]);
	});

	it("P: flags dgram.createSocket acquisition with throw before .close()", () => {
		const code = [
			"function bug() {",
			"  const sock = dgram.createSocket('udp4');",
			"  if (cond) throw new Error('bad');",
			"  sock.close();",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out).toEqual([{ line: 3, text: "if (cond) throw new Error('bad');" }]);
	});
});

describe("checkCleanupSkippedOnEarlyExit — finding shape (line/text) construction, positive cases (must fire)", () => {
	// Pins the EXACT { line, text } for a single finding. Kills, all at
	// once: recordExit's `"\n"` -> `""` StringLiteral mutants (both the
	// `content.split` for `lines` and the `stripped.slice(...).split` for
	// `lineNo`), the `stripped.slice(0, exitOffset)` -> `stripped`
	// MethodExpression, the `.trim()` removal, the `||` -> `&&`
	// LogicalOperator, the `lineNo - 1` -> `lineNo + 1` ArithmeticOperator,
	// the whole `{ line, text }` -> `{}` ObjectLiteral, and the main-loop
	// `acqEnd + exitIndex` -> `acqEnd - exitIndex` ArithmeticOperator — each
	// corrupts `line` and/or `text` away from this exact expected value.
	it("P: records the exact { line, text } for a setInterval early-exit finding", () => {
		const code = [
			"function bug() {",
			"  const id = setInterval(() => tick(), 1000);",
			"  if (cond) throw new Error('bad');",
			"  clearInterval(id);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out).toEqual([{ line: 3, text: "if (cond) throw new Error('bad');" }]);
	});

	// Same coverage as above, but for the addEventListener loop's OWN copy
	// of the offset arithmetic (`acqEnd + exitIndex` -> `acqEnd -
	// exitIndex`, a separate mutation site from the main loop's).
	it("P: records the exact { line, text } for an addEventListener early-exit finding", () => {
		const code = [
			"function bug(target: EventTarget, handler: () => void) {",
			"  target.addEventListener('click', handler);",
			"  if (!enabled) return;",
			"  target.removeEventListener('click', handler);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out).toEqual([{ line: 3, text: "if (!enabled) return;" }]);
	});

	// Kills the `addHit.index + addHit[0].length` -> `addHit.index -
	// addHit[0].length` ArithmeticOperator. A plain addEventListener fixture
	// can't distinguish this mutant (the wrongly-shifted window still
	// contains the same removeEventListener call and no other exit
	// keyword, so the offset error mathematically cancels out — see
	// scratch/probes/cleanup-early-exit-mutant-check.mjs's Fixture G vs K).
	// An EARLIER throw/return close enough for the mis-shifted window to
	// swallow it makes the corruption observable: the real code correctly
	// ignores the earlier throw (it precedes the acquisition) and reports
	// the later `return`; the mutant reports the earlier `throw` instead.
	it("P: addEventListener still resolves the acquisition's OWN early-exit, not an earlier unrelated one", () => {
		const code = [
			"function bug(target, handler) {",
			"if (x) throw e;",
			"target.addEventListener('click', handler);",
			"  if (!enabled) return;",
			"  target.removeEventListener('click', handler);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out).toEqual([{ line: 4, text: "if (!enabled) return;" }]);
	});

	// Kills the `.slice(0, REPORT_LINE_TRUNC)` removal — a short line can't
	// distinguish "no truncation happened" from "truncation happened but
	// the line was already under the limit". A 160-char reported line must
	// come back as exactly 150 chars.
	it("P: truncates a long reported line to exactly 150 characters", () => {
		const longSuffix = "x".repeat(160);
		const code = [
			"function bug() {",
			"  const id = setInterval(tick, 1000);",
			`  if (cond) throw new Error('bad'); // ${longSuffix}`,
			"  clearInterval(id);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out[0]?.text.length).toBe(150);
	});
});

describe("checkCleanupSkippedOnEarlyExit — MAX_MATCHES / dedup behavior, positive cases (must fire)", () => {
	// Kills `seen.has(lineNo)` -> `false`: two acquisitions whose early-exit
	// resolves to the SAME physical line (setInterval and setTimeout both
	// windowing over the same shared `throw`) must collapse to one finding.
	it("P: two acquisitions reporting the same source line collapse to one finding", () => {
		const code = [
			"function bug() {",
			"  const id = setInterval(tick, 1000);",
			"  const tid = setTimeout(fire, 100);",
			"  if (cond) throw new Error('bad');",
			"  clearInterval(id);",
			"  clearTimeout(tid);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out).toEqual([{ line: 4, text: "if (cond) throw new Error('bad');" }]);
	});

	// Kills recordExit's cap-check ConditionalExpression -> `true` and the
	// EqualityOperator `>=` -> `<` variant: both make recordExit signal
	// "stop" after the very FIRST finding, well under the 10-match cap, so
	// only ONE of two well-separated, unrelated findings would be reported.
	it("P: reports every distinct early-exit finding, not just the first", () => {
		const code = [
			"function bugOne() {",
			"  const id = setInterval(tick, 1000);",
			"  if (condA) throw new Error('bad');",
			"  clearInterval(id);",
			"}",
			"function bugTwo() {",
			"  const tid = setTimeout(fire, 100);",
			"  if (condB) return;",
			"  clearTimeout(tid);",
			"}",
		].join("\n");
		const out = checkCleanupSkippedOnEarlyExit(code, TS);
		expect(out).toEqual([
			{ line: 3, text: "if (condA) throw new Error('bad');" },
			{ line: 8, text: "if (condB) return;" },
		]);
	});
});

describe("checkCleanupSkippedOnEarlyExit — addEventListener regex/receiver edge cases, positive cases (must fire)", () => {
	// Kills the addEventListener acquisition regex's `\s*` -> `\S*`
	// (right before the call's opening paren): a literal space there can't
	// be matched by `\S*`.
	it("P: matches addEventListener with whitespace before the call's opening paren", () => {
		const code = [
			"function bug(target: EventTarget, handler: () => void) {",
			"  target.addEventListener ('click', handler);",
			"  if (!enabled) return;",
			"  target.removeEventListener ('click', handler);",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS).length).toBe(1);
	});

	// Kills the `receiver.replace(/[.]/g, "\\.")` -> `receiver.replace(/[.]/g, "")`
	// StringLiteral mutant: with the dot stripped instead of escaped, the
	// constructed removeEventListener regex looks for the literal text
	// "thisemitter" (no dot) instead of "this\.emitter", which never
	// appears in the real "this.emitter.removeEventListener(...)" call.
	it("P: matches an addEventListener/removeEventListener pair on a dotted receiver", () => {
		const code = [
			"function bug() {",
			"  this.emitter.addEventListener('click', handler);",
			"  if (!enabled) return;",
			"  this.emitter.removeEventListener('click', handler);",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS).length).toBe(1);
	});
});

describe("checkCleanupSkippedOnEarlyExit — lookahead window and try-guard, negative cases (must NOT fire)", () => {
	// Kills the main-loop `Math.min(stripped.length, acqHit.index +
	// LOOKAHEAD_CHARS)` -> `Math.max(...)`: a short fixture can't
	// distinguish Math.min from Math.max (String.slice silently clamps an
	// out-of-range end index to the string length either way), so the
	// acquisition and its cleanup must be separated by MORE than
	// LOOKAHEAD_CHARS (5000) for the real code to correctly stay silent
	// while the mutant (unbounded window) incorrectly finds the far-away
	// cleanup and reports a finding.
	it("N: does not pair an acquisition with a cleanup call more than 5000 chars away", () => {
		const filler = Array.from({ length: 900 }, () => "  x();").join("\n");
		const code = [
			"function ok() {",
			"  const id = setInterval(tick, 1000);",
			"  if (cond) throw new Error('bad');",
			filler,
			"  clearInterval(id);",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});

	// Same coverage as above, for the addEventListener loop's OWN copy of
	// the Math.min/Math.max windowEnd computation (a separate mutation
	// site from the main loop's).
	it("N: does not pair addEventListener/removeEventListener more than 5000 chars apart", () => {
		const filler = Array.from({ length: 900 }, () => "  x();").join("\n");
		const code = [
			"function ok(target: EventTarget, handler: () => void) {",
			"  target.addEventListener('click', handler);",
			"  if (!enabled) return;",
			filler,
			"  target.removeEventListener('click', handler);",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});

	// Kills the `/\btry\s*\{/` -> `/\btry\s\{/` Regex mutant: `\s*` (zero or
	// more) matches "try{" with NO space, but the mutant's `\s` (exactly
	// one) requires a space that isn't there, so the mutant fails to
	// recognize the try-guard and incorrectly reports a finding.
	it("N: recognizes a try{ guard with no space before the brace", () => {
		const code = [
			"function ok() {",
			"  const id = setInterval(tick, 1000);",
			"  try{",
			"    if (cond) throw new Error('bad');",
			"  } finally {",
			"    clearInterval(id);",
			"  }",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});

	// Kills the `!JS_TS_ALL_EXTS.includes(ext)` -> `false` ConditionalExpression:
	// content that structurally matches the acquire/exit/cleanup shape must
	// still be ignored outright for a non-JS/TS extension.
	it("N: does not scan a non-JS/TS file even when its content matches the acquire/exit/cleanup shape", () => {
		const code = [
			"function bug() {",
			"  const id = setInterval(tick, 1000);",
			"  if (cond) { throw new Error('bad'); }",
			"  clearInterval(id);",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, "foo.py")).toEqual([]);
	});

	// Kills the addEventListener loop's OWN `exitIndex === null` -> `false`
	// ConditionalExpression (the main loop's identical-looking check is
	// already covered by the pre-existing "cleanup runs BEFORE the throw"
	// test above it in the integration suite). With the guard neutralized,
	// `recordExit(acqEnd + null)` still evaluates (null coerces to 0 in
	// `+`), producing a spurious finding at the acquisition's own offset
	// even though there is genuinely no early-exit to report.
	it("N: does not fire when the addEventListener cleanup runs BEFORE the early exit", () => {
		const code = [
			"function ok(target, handler) {",
			"  target.addEventListener('click', handler);",
			"  if (cond) {",
			"    target.removeEventListener('click', handler);",
			"    return;",
			"  }",
			"  target.removeEventListener('click', handler);",
			"}",
		].join("\n");
		expect(checkCleanupSkippedOnEarlyExit(code, TS)).toEqual([]);
	});
});
