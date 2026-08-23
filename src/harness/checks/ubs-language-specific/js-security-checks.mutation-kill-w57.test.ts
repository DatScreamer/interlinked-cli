import { describe, expect, it } from "vitest";
import {
	checkCookieMissingSecurityFlags,
	checkMixedSyncAsyncFileApi,
} from "./js-security-checks.js";

describe("checkMixedSyncAsyncFileApi — positive (must fire)", () => {
	// test-contract: public-api — checkMixedSyncAsyncFileApi must flag a function
	// body that mixes a sync fs call with an awaited fs call.
	it("P1: flags a function that mixes fs.*Sync and await fs.* in the same body", () => {
		// Kills mutantId 74e9ccafd23d75f9 (findFunctionBodies: `openIdx + 1` -> `openIdx - 1`).
		// With the mutant, the body-range scan starts at the wrong offset, the brace
		// depth never balances to 0, and no function body range is produced at all —
		// so the mixed-API scan finds nothing and this check silently returns [].
		const content = [
			"function loadThenSave() {",
			"  fs.readFileSync('a');",
			"  await fs.readFile('b');",
			"}",
			"",
		].join("\n");
		const matches = checkMixedSyncAsyncFileApi(content, "src/example.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.line).toBe(3);
		expect(matches[0]?.text).toContain("await fs.readFile");
	});

	// test-contract: public-api — same body-range extraction path corroborated
	// with a longer function body and a nested for-loop before the await call.
	it("P2: still fires when the mixed call site sits deep inside a longer function body", () => {
		// Independent corroboration for the same body-range extraction: without a
		// correctly closed range the scan never reaches line 5's await call either.
		const content = [
			"function process(item) {",
			"  const out = [];",
			"  out.push(item);",
			"  fs.writeFileSync(item.path, item.data);",
			"  await fs.appendFile('log', 'done');",
			"}",
			"",
		].join("\n");
		const matches = checkMixedSyncAsyncFileApi(content, "src/example2.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.some((m) => m.line === 5)).toBe(true);
	});
});

describe("checkMixedSyncAsyncFileApi — negative (must not fire)", () => {
	// test-contract: invariant — a sync-only function body has nothing to flag.
	it("N1: does not fire when only the sync form is used", () => {
		const content = ["function loadOnly() {", "  fs.readFileSync('a');", "}", ""].join("\n");
		expect(checkMixedSyncAsyncFileApi(content, "src/example3.ts")).toEqual([]);
	});
});

describe("checkCookieMissingSecurityFlags — positive (must fire)", () => {
	// test-contract: security — checkCookieMissingSecurityFlags must flag a
	// res.cookie(...) call whose options omit `secure: true`.
	it("P1: flags res.cookie(...) missing the secure flag", () => {
		// Kills mutantId 4505d8c78a37447f (sliceBalancedParens: `openIdx + 1` -> `openIdx - 1`).
		// The mutant starts the paren-balance scan one character too early (re-counting
		// the opening paren itself), so depth never returns to 0 within the call and
		// sliceBalancedParens returns null — the call site is silently skipped and no
		// violation is ever recorded, even though the cookie is missing `secure: true`.
		const content = "res.cookie('sid', sessionId, { httpOnly: true });\n";
		const matches = checkCookieMissingSecurityFlags(content, "src/routes.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.line).toBe(1);
		expect(matches[0]?.text).toContain("res.cookie");
	});

	// test-contract: security — same paren-balancing path corroborated with a
	// nested `new Date(...)` call inside the options object before the closing paren.
	it("P2: flags res.cookie(...) whose options object contains a nested call before the closing paren", () => {
		// Corroborates the same paren-balancing fix path with a call whose argument
		// list itself is longer / contains nested parens, exercising more scan steps.
		const content =
			"res.cookie('sid', sessionId, { httpOnly: true, expires: new Date(Date.now() + 1000) });\n";
		const matches = checkCookieMissingSecurityFlags(content, "src/routes2.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.line).toBe(1);
	});
});

describe("checkCookieMissingSecurityFlags — negative (must not fire)", () => {
	// test-contract: invariant — a fully-secured cookie call has nothing to flag.
	it("N1: does not fire when both httpOnly and secure are true", () => {
		const content = "res.cookie('sid', sessionId, { httpOnly: true, secure: true });\n";
		expect(checkCookieMissingSecurityFlags(content, "src/routes3.ts")).toEqual([]);
	});
});
