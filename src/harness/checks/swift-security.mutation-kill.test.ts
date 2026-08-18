// Mutation-kill companion for swift-security.ts (PASS-1, wave pass1_w19).
// Each case pins an OBSERVABLE behavior via an exact-value assertion
// (toEqual on the full match array, never a bare .length or .toContain)
// so the specific surviving mutant it targets cannot silently pass.
// See scratch/fleet-r3/CONTRACT-W6.md for the receipt grammar and
// scratch/fleet-r3/receipts/src_harness_checks_swift-security.ts.jsonl
// for the mutantId -> testName mapping.

import { describe, expect, it } from "vitest";
import {
	checkSwiftAtsArbitraryLoads,
	checkSwiftHttpUrlLiteral,
	checkSwiftUserDefaultsForSecret,
	checkSwiftWeakCrypto,
} from "./swift-security.js";

describe("checkSwiftWeakCrypto — mutation kills", () => {
	// test-contract: invariant — a pushed match's {line,text} must reflect
	// the ORIGINAL source line verbatim, not a line-splitting artifact.
	it("exact match shape for a single-line CC_MD5 hit", () => {
		const code = "CC_MD5(input, CC_LONG(len), &out)";
		expect(checkSwiftWeakCrypto(code, "Crypto.swift")).toEqual([{ line: 1, text: code }]);
	});
});

describe("checkSwiftHttpUrlLiteral — mutation kills", () => {
	// test-contract: security — 172.15.x.x is NOT in the 172.16-31 private
	// range and must still be flagged as an insecure public HTTP literal.
	it("flags http://172.15.x.x (just below the 172.16-31 private range)", () => {
		const code = 'let u = URL(string: "http://172.15.1.1/x")';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift").length).toBe(1);
	});

	// test-contract: security — 172.20.x.x falls inside the 172.16-31
	// private range and must NOT be flagged.
	it("does not flag http://172.20.x.x (inside the 172.16-31 private range)", () => {
		const code = 'let u = URL(string: "http://172.20.1.1/x")';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	// test-contract: boundary — 172.31.x.x is the private range's upper
	// edge and must NOT be flagged.
	it("does not flag http://172.31.x.x (upper edge of the private range)", () => {
		const code = 'let u = URL(string: "http://172.31.1.1/x")';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	// test-contract: security — the ".local" exemption requires a real word
	// boundary after "local"; a "localhost"-suffixed host is not the mDNS
	// TLD and must still be flagged.
	it("flags http://host.localhost (not the .local mDNS exemption)", () => {
		const code = 'let u = URL(string: "http://my-printer.localhost/status")';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift").length).toBe(1);
	});

	// test-contract: invariant — an unterminated string literal (no closing
	// quote) is not a detectable URL literal.
	it("does not flag an unterminated http:// string literal", () => {
		const code = 'let u = "http://api.example.com';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	// test-contract: invariant — MATCH_LIMIT (10) is a hard cap: an 11th
	// matching line must never be included.
	it("caps at exactly MATCH_LIMIT (10) matches, not 11", () => {
		const lines = Array.from(
			{ length: 11 },
			(_, i) => `let u${i} = URL(string: "http://host${i}.example.com/x")`,
		);
		expect(checkSwiftHttpUrlLiteral(lines.join("\n"), "Net.swift").length).toBe(10);
	});

	// test-contract: public-api — a `//` line comment containing a quoted
	// URL literal must never be scanned (docstring: "comment lines").
	it("does not flag a quoted URL inside a // comment", () => {
		const code = '// see "http://api.example.com/foo" for reference';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	// test-contract: public-api — a `/* ... */` block-comment OPENING line
	// containing a quoted URL must never be scanned.
	it("does not flag a quoted URL on a /* block-comment opening line", () => {
		const code = '/* see "http://api.example.com/foo" */';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	// test-contract: public-api — a `*`-prefixed block-comment CONTINUATION
	// line containing a quoted URL must never be scanned.
	it("does not flag a quoted URL on a * continuation line", () => {
		const code = '* see "http://api.example.com/foo" here';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	// test-contract: boundary — leading indentation before `//` must not
	// defeat the comment-skip guard (it strips leading whitespace first).
	it("recognizes a // comment even when indented", () => {
		const code = '   // "http://api.example.com/foo"';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	// test-contract: invariant — pushed match fields must be exact: correct
	// 1-based line number, whitespace-trimmed, and capped at 150 chars.
	it("exact match shape: trims whitespace and caps text at 150 chars", () => {
		const raw = `   let u = URL(string: "http://api.example.com/${"a".repeat(160)}")   `;
		const expectedText = raw.trim().slice(0, 150);
		expect(checkSwiftHttpUrlLiteral(raw, "Net.swift")).toEqual([{ line: 1, text: expectedText }]);
	});
});

describe("checkSwiftUserDefaultsForSecret — mutation kills", () => {
	// test-contract: public-api — whitespace between "UserDefaults" and the
	// following `.member`/`(args)` must still be tolerated.
	it("recognizes UserDefaults with whitespace before the dot", () => {
		const code = 'UserDefaults .standard.set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	// test-contract: boundary — a single-character member name (the
	// shortest possible identifier) must still be recognized.
	it("recognizes UserDefaults with a 1-character member name", () => {
		const code = 'UserDefaults.x.set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	// test-contract: boundary — empty parens `UserDefaults()` (no suite
	// name argument) must still be recognized.
	it("recognizes UserDefaults() with empty parens", () => {
		const code = 'UserDefaults().set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	// test-contract: public-api — UserDefaults(suiteName:) is the second
	// docstring-documented detection style.
	it("recognizes UserDefaults(suiteName:) form", () => {
		const code = 'UserDefaults(suiteName: "x").set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	// test-contract: invariant — exact match shape (line/text) for the
	// canonical @AppStorage form; also the SUT anchor for the sensitive-key
	// regex table below.
	it("exact match shape for @AppStorage(sensitive key)", () => {
		const code = '@AppStorage("authToken") var authToken: String = ""';
		expect(checkSwiftUserDefaultsForSecret(code, "View.swift")).toEqual([
			{ line: 1, text: code },
		]);
	});

	// test-contract: public-api — whitespace between "@AppStorage" and the
	// following "(" must still be tolerated.
	it("recognizes @AppStorage with whitespace before the paren", () => {
		const code = '@AppStorage ("authToken") var authToken: String = ""';
		expect(checkSwiftUserDefaultsForSecret(code, "View.swift").length).toBe(1);
	});

	// test-contract: invariant — MATCH_LIMIT (10) is a hard cap.
	it("caps at exactly MATCH_LIMIT (10) matches, not 11", () => {
		const lines = Array.from({ length: 11 }, () => 'UserDefaults.standard.set(pw, forKey: "password")');
		expect(checkSwiftUserDefaultsForSecret(lines.join("\n"), "Auth.swift").length).toBe(10);
	});

	// test-contract: boundary — leading indentation before `//` must not
	// defeat the comment-skip guard.
	it("recognizes a // comment even when indented (UserDefaults)", () => {
		const code = '   // UserDefaults.standard.set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift")).toEqual([]);
	});

	// test-contract: public-api — a `//` comment line must never be
	// scanned, even one containing a sensitive-looking UserDefaults call.
	it("does not flag a UserDefaults call inside a // comment", () => {
		const code = '// UserDefaults.standard.set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift")).toEqual([]);
	});

	// test-contract: public-api — a `/* ... */` block-comment opening line
	// must never be scanned.
	it("does not flag a UserDefaults call on a /* block-comment line", () => {
		const code = '/* UserDefaults.standard.set(pw, forKey: "password") */';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift")).toEqual([]);
	});

	// test-contract: public-api — a `*`-prefixed continuation line must
	// never be scanned.
	it("does not flag a UserDefaults call on a * continuation line", () => {
		const code = '* UserDefaults.standard.set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift")).toEqual([]);
	});

	// test-contract: invariant — the @AppStorage push path's text must be
	// trimmed and capped at 150 chars (independent of the forKey path).
	it("@AppStorage exact shape: trims whitespace and caps text at 150 chars", () => {
		const raw = `   @AppStorage("authToken") var authToken: String = "${"x".repeat(160)}"   `;
		const expectedText = raw.trim().slice(0, 150);
		expect(checkSwiftUserDefaultsForSecret(raw, "View.swift")).toEqual([
			{ line: 1, text: expectedText },
		]);
	});

	// test-contract: invariant — exact match shape (line/text) for the
	// canonical UserDefaults...forKey: form.
	it("exact match shape for UserDefaults...forKey(sensitive key)", () => {
		const code = 'UserDefaults.standard.set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift")).toEqual([
			{ line: 1, text: code },
		]);
	});

	// test-contract: boundary — whitespace before the ":" must still be
	// tolerated.
	it("recognizes forKey with whitespace before the colon", () => {
		const code = 'UserDefaults.standard.set(pw, forKey : "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	// test-contract: boundary — zero whitespace after the ":" must still be
	// tolerated (that whitespace is optional, not required).
	it("recognizes forKey with no whitespace after the colon", () => {
		const code = 'UserDefaults.standard.set(pw, forKey:"password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	// test-contract: invariant — the forKey push path's text must be
	// trimmed and capped at 150 chars (independent of the @AppStorage path).
	// Padding lives in a trailing comment, OUTSIDE the forKey capture group,
	// so the sensitive-key value itself ("password") still matches.
	it("forKey exact shape: trims whitespace and caps text at 150 chars", () => {
		const raw = `   UserDefaults.standard.set(pw, forKey: "password") // ${"a".repeat(160)}   `;
		const expectedText = raw.trim().slice(0, 150);
		expect(checkSwiftUserDefaultsForSecret(raw, "Auth.swift")).toEqual([
			{ line: 1, text: expectedText },
		]);
	});

	// test-contract: invariant — the base UserDefaults[...] = subscript
	// form's exact match shape, and the guard that gates the push.
	it("exact match shape for UserDefaults[sensitive key] = value", () => {
		const code = 'UserDefaults.standard["password"] = value';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift")).toEqual([
			{ line: 1, text: code },
		]);
	});

	// test-contract: boundary — whitespace right after "[" must still be
	// tolerated.
	it("recognizes a subscript with whitespace after [", () => {
		const code = 'UserDefaults.standard[ "password"] = value';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	// test-contract: boundary — whitespace right before "]" must still be
	// tolerated.
	it("recognizes a subscript with whitespace before ]", () => {
		const code = 'UserDefaults.standard["password" ] = value';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	// test-contract: boundary — zero whitespace between "]" and "=" must
	// still be tolerated.
	it("recognizes a subscript with no whitespace before =", () => {
		const code = 'UserDefaults.standard["password"]= value';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	// test-contract: security — each sensitive-key spelling in the
	// alternation table must independently gate detection (a mutant that
	// narrows one alternative's separator class must not stop that
	// spelling from matching). Routed through @AppStorage's single capture.
	it.each([
		["api_key"],
		["privateKey"],
		["private_key"],
		["accessToken"],
		["refreshToken"],
		["refresh_token"],
		["auth_token"],
		["sessionId"],
		["session_id"],
	])("flags @AppStorage sensitive key spelling %s", (key) => {
		const code = `@AppStorage("${key}") var x: String = ""`;
		expect(checkSwiftUserDefaultsForSecret(code, "View.swift")).toEqual([
			{ line: 1, text: code },
		]);
	});
});

describe("checkSwiftAtsArbitraryLoads — mutation kills", () => {
	// test-contract: security — the .plist extension guard must return
	// early for ANY non-.plist file, even one containing a literal ATS
	// bypass payload.
	it("does not scan a non-.plist file even with a literal ATS bypass payload", () => {
		const code = "<key>NSAllowsArbitraryLoads</key><true/>";
		expect(checkSwiftAtsArbitraryLoads(code, "Foo.swift")).toEqual([]);
	});

	// test-contract: boundary — whitespace between "true" and "/>" must
	// still be tolerated.
	it("recognizes <true/> with whitespace before the slash", () => {
		const code = "<key>NSAllowsArbitraryLoads</key><true \t/>";
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist").length).toBe(1);
	});

	// test-contract: boundary — whitespace before "YES" must still be
	// tolerated.
	it("recognizes <string> YES</string> with leading whitespace", () => {
		const code = "<key>NSAllowsArbitraryLoads</key><string> YES</string>";
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist").length).toBe(1);
	});

	// test-contract: boundary — whitespace after "YES" must still be
	// tolerated.
	it("recognizes <string>YES </string> with trailing whitespace", () => {
		const code = "<key>NSAllowsArbitraryLoads</key><string>YES </string>";
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist").length).toBe(1);
	});

	// test-contract: invariant — when the SAME line already carries an
	// explicit <false/>, the lookahead over following lines must never run.
	it("stops at an explicit <false/> and never looks ahead", () => {
		const code = ["<key>NSAllowsArbitraryLoads</key><false/>", "<true/>"].join("\n");
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([]);
	});

	// test-contract: boundary — whitespace before "/>" in <false /> must
	// still be tolerated by FALSE_RE.
	it("recognizes <false /> with whitespace before the slash", () => {
		const code = ["<key>NSAllowsArbitraryLoads</key><false />", "<true/>"].join("\n");
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([]);
	});

	// test-contract: boundary — zero whitespace around "NO" in
	// <string>NO</string> must still be tolerated by FALSE_RE.
	it("recognizes <string>NO</string> with no surrounding whitespace", () => {
		const code = ["<key>NSAllowsArbitraryLoads</key><string>NO</string>", "<true/>"].join("\n");
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([]);
	});

	// test-contract: boundary — whitespace around "NO" in
	// <string> NO </string> must still be tolerated by FALSE_RE.
	it("recognizes <string> NO </string> with surrounding whitespace", () => {
		const code = ["<key>NSAllowsArbitraryLoads</key><string> NO </string>", "<true/>"].join(
			"\n",
		);
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([]);
	});

	// test-contract: invariant — MATCH_LIMIT (10) is a hard cap.
	it("caps at exactly MATCH_LIMIT (10) matches, not 11 (ATS)", () => {
		const lines = Array.from({ length: 11 }, () => "<key>NSAllowsArbitraryLoads</key><true/>");
		expect(checkSwiftAtsArbitraryLoads(lines.join("\n"), "Info.plist").length).toBe(10);
	});

	// test-contract: boundary — whitespace right after "<key>" must still
	// be tolerated.
	it("recognizes <key> with whitespace before the tag name", () => {
		const code = "<key> NSAllowsArbitraryLoads</key><true/>";
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist").length).toBe(1);
	});

	// test-contract: boundary — whitespace right before "</key>" must still
	// be tolerated.
	it("recognizes <key> with whitespace before the closing tag", () => {
		const code = "<key>NSAllowsArbitraryLoads </key><true/>";
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist").length).toBe(1);
	});

	// test-contract: invariant — the lookahead must scan FORWARD from the
	// key line (i+1), never backward past the start of the array.
	it("looks ahead (not behind) for the value when the key line has none", () => {
		const code = ["<key>NSAllowsArbitraryLoads</key>", "<true/>"].join("\n");
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([
			{ line: 1, text: "<key>NSAllowsArbitraryLoads</key>" },
		]);
	});

	// test-contract: boundary — the lookahead window is exactly i+1..i+3
	// (3 lines); a value on the 4th following line must NOT be found.
	it("does not look ahead past a 3-line window", () => {
		const code = [
			"<key>NSAllowsArbitraryLoads</key>",
			"neutral 1",
			"neutral 2",
			"neutral 3",
			"<true/>",
		].join("\n");
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([]);
	});

	// test-contract: boundary — when the key line is the LAST line (no
	// following lines exist), the lookahead must not scan past the array.
	it("does not scan past the end of the file when the key is the last line", () => {
		const code = "<key>NSAllowsArbitraryLoads</key>";
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([]);
	});

	// test-contract: invariant — once the lookahead sees an explicit
	// <false/>, it must stop (not keep looking for a later <true/>).
	it("stops the lookahead at the first <false/>, ignoring a later <true/>", () => {
		const code = ["<key>NSAllowsArbitraryLoads</key>", "<false/>", "<true/>"].join("\n");
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([]);
	});

	// test-contract: invariant — the lookahead must keep scanning past a
	// NEUTRAL line (neither true nor false) to find a later <true/>.
	it("continues the lookahead past a neutral line to find a later <true/>", () => {
		const code = ["<key>NSAllowsArbitraryLoads</key>", "neutral", "<true/>"].join("\n");
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([
			{ line: 1, text: "<key>NSAllowsArbitraryLoads</key>" },
		]);
	});

	// test-contract: invariant — pushed match fields must be exact: correct
	// 1-based line number, whitespace-trimmed, and capped at 150 chars.
	it("exact match shape: trims whitespace and caps text at 150 chars (ATS)", () => {
		const raw = `   <key>NSAllowsArbitraryLoads</key><true/><!-- ${"a".repeat(160)} -->   `;
		const expectedText = raw.trim().slice(0, 150);
		expect(checkSwiftAtsArbitraryLoads(raw, "Info.plist")).toEqual([
			{ line: 1, text: expectedText },
		]);
	});
});
