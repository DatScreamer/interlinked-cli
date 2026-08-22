// Mutation-kill companion for suppressions.ts (wave 30, pass1).
//
// Targets 26 of the 41 mutants recorded as "survived" for suppressions.ts in
// .interlinked/mutation-manifest.json. The remaining 15 are left still_open
// in the receipts — hand-traced and suspected equivalent (regex-quantifier
// or symmetric-offset changes whose only observable difference is consumed
// entirely by a downstream `.trim()`, or Annex-B regex leniency that makes
// an unescaped bracket/brace behave identically to an escaped one) — no
// killing test was written for those, per the write-only contract.
//
// `readFileSync` / `statSync` / `mkdirSync` are wrapped as call-through
// spies so several mutants (skip-early-return-then-let-the-catch-mask-it)
// can be killed by call-count rather than return value alone: plain
// `vi.spyOn(fs, ...)` throws "Module namespace is not configurable in ESM"
// for node:fs, so this follows the same `vi.mock` + `vi.hoisted` workaround
// used in `src/lib/config.mutation-kill.test.ts`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readFileSyncSpy, statSyncSpy, mkdirSyncSpy } = vi.hoisted(() => {
	return {
		readFileSyncSpy: vi.fn(),
		statSyncSpy: vi.fn(),
		mkdirSyncSpy: vi.fn(),
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	readFileSyncSpy.mockImplementation(actual.readFileSync);
	statSyncSpy.mockImplementation(actual.statSync);
	mkdirSyncSpy.mockImplementation(actual.mkdirSync);
	return {
		...actual,
		readFileSync: readFileSyncSpy,
		statSync: statSyncSpy,
		mkdirSync: mkdirSyncSpy,
	};
});

import { addSuppressions, loadFileSuppressions, loadSuppressionFile } from "./suppressions.js";

describe("suppressions.ts mutation-kill (wave 30)", () => {
	let dir: string;
	const jsonPath = () => join(dir, "verify-suppressions.json");
	const write = (data: unknown) => writeFileSync(jsonPath(), JSON.stringify(data, null, 2), "utf-8");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "suppressions-mk-"));
		readFileSyncSpy.mockClear();
		statSyncSpy.mockClear();
		mkdirSyncSpy.mockClear();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — kills 64edbf5258b0b127 (cache condition -> false),
	// b3a25e40797188d0 (cache path object -> {}), 54c5816af5cd3da6 (cache
	// inner object -> {}): all three force a re-parse on every call, which is
	// invisible in the RETURN VALUE (same file, same data) but visible as an
	// extra readFileSync call.
	it("mutation-kill: caches the parsed suppression file across calls with the same mtime", () => {
		write({ "src/a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
		readFileSyncSpy.mockClear();
		loadFileSuppressions(dir, "src/a.ts");
		loadFileSuppressions(dir, "src/a.ts");
		const jsonReads = readFileSyncSpy.mock.calls.filter((c) => c[0] === jsonPath()).length;
		expect(jsonReads).toBe(1);
	});

	// test-contract: bug — kills de11fc36164e6601 (`!entry` -> false): a
	// falsy entry that IS reached (its pattern matches) must not crash
	// Object.keys and erase checks already collected from an earlier
	// matching pattern in the same file.
	it("mutation-kill: a falsy entry for one pattern does not erase checks already collected from another matching pattern", () => {
		write({
			"src/*.ts": { foo: { reason: "x", by: "cli", at: "n" } },
			"src/a.ts": null,
		});
		const checks = loadFileSuppressions(dir, "src/a.ts");
		expect(checks.has("foo")).toBe(true);
		expect(checks.size).toBe(1);
	});

	// test-contract: invariant — kills 9233fc23b1080097 (`!existsSync(filePath)`
	// -> false): removing the early return still yields the same empty-set
	// RETURN (statSync throws ENOENT, caught), so the observable is the
	// call itself, not the result.
	it("mutation-kill: never stats a suppression file that does not exist", () => {
		const result = loadFileSuppressions(dir, "src/a.ts");
		expect(result.size).toBe(0);
		expect(statSyncSpy).not.toHaveBeenCalled();
	});

	// test-contract: invariant — kills b3ff43725bf972b3 (wildcard-check ->
	// true), 0d5949361b7db6a2 (`"*"` -> `""`, making `includes("")`
	// unconditionally true), c36625b2cc9e4d3c (`"?"` -> `""`, same
	// effect): all three force every pattern through glob matching, which
	// normalizes `\` to `/` — a wildcard-free pattern that legitimately
	// fails an exact-string match must not "match" via that normalization.
	it("mutation-kill: a non-wildcard pattern never triggers glob normalization on a mismatched path", () => {
		write({ "src/a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "src\\a.ts").has("foo")).toBe(false);
	});

	// test-contract: invariant — kills d5ceecaf34b2b435 (`!existsSync(filePath)`
	// -> false) in loadSuppressionFile: same masked-by-catch shape as the
	// statSync case above, observable via the readFileSync call count.
	it("mutation-kill: loadSuppressionFile never reads a file that does not exist", () => {
		const result = loadSuppressionFile(dir);
		expect(result).toEqual({});
		const jsonReads = readFileSyncSpy.mock.calls.filter((c) => c[0] === jsonPath()).length;
		expect(jsonReads).toBe(0);
	});

	// test-contract: invariant — kills 945c5108617429ef (`existsSync(filePath)`
	// -> true) in addSuppressions: forces a readFileSync attempt on a file
	// that doesn't exist yet; the ENOENT is caught either way so the
	// RETURN is unaffected, only the call count differs.
	it("mutation-kill: addSuppressions never reads a file that does not exist yet", () => {
		addSuppressions(dir, [{ file: "src/a.ts", check: "foo", reason: "" }]);
		const jsonReads = readFileSyncSpy.mock.calls.filter((c) => c[0] === jsonPath()).length;
		expect(jsonReads).toBe(0);
	});

	// test-contract: invariant — kills fa76885304af0f14 (`!existsSync(interlinkedDir)`
	// -> true): mkdirSync with recursive:true is a silent no-op on an
	// existing directory, so this too is only observable as a call.
	it("mutation-kill: addSuppressions does not call mkdir when the directory already exists", () => {
		addSuppressions(dir, [{ file: "src/a.ts", check: "foo", reason: "" }]);
		expect(mkdirSyncSpy).not.toHaveBeenCalled();
	});

	// test-contract: bug — kills 813e73b8528dfbdb (`"utf-8"` -> `""`):
	// an invalid/empty encoding string makes Node's writeFileSync throw
	// synchronously (unknown encoding), uncaught by addSuppressions.
	it("mutation-kill: writes the suppression file with a valid utf-8 encoding (does not throw)", () => {
		expect(() =>
			addSuppressions(dir, [{ file: "src/a.ts", check: "foo", reason: "" }]),
		).not.toThrow();
	});

	// test-contract: public-api — kills c35df8c2676f9b1e (opening `"^"` anchor ->
	// `""`): without the start anchor, a glob would match as a substring
	// anywhere in the path instead of requiring an exact-position start.
	it("mutation-kill: glob matching is anchored at the start of the path", () => {
		write({ "a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "xa.ts").has("foo")).toBe(false);
		expect(loadFileSuppressions(dir, "a.ts").has("foo")).toBe(true);
	});

	// test-contract: public-api — kills c030ec1ffcad79a2 (closing `"$"` anchor ->
	// `""`): without the end anchor, a glob would match any string with
	// the required prefix, ignoring trailing characters.
	it("mutation-kill: glob matching is anchored at the end of the path", () => {
		write({ "a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "a.tsx").has("foo")).toBe(false);
		expect(loadFileSuppressions(dir, "a.ts").has("foo")).toBe(true);
	});

	// test-contract: bug — kills 4e3df4076a069351 (`i + 1` -> `i - 1` in
	// the `**` lookahead check): breaks recognition of the FIRST star in a
	// `**` pair (checks the previous char instead of the next), which
	// silently drops a literal character later in the pattern.
	it("mutation-kill: a `**` sequence is recognized by looking ahead, not behind", () => {
		write({ "a**b": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "axyzb").has("foo")).toBe(true);
		expect(loadFileSuppressions(dir, "axyz").has("foo")).toBe(false);
	});

	// test-contract: bug — kills 16c997354b0ad8ff (`p[i] === "/"` ->
	// `true` after a `**`): unconditionally skips the next character
	// instead of only a literal `/`, dropping a real pattern character.
	it("mutation-kill: only a literal `/` right after `**` gets skipped", () => {
		write({ "**foo": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "xyzfoo").has("foo")).toBe(true);
		expect(loadFileSuppressions(dir, "xyzoo").has("foo")).toBe(false);
	});

	// test-contract: public-api — kills ebc34750dde3b1e6 (meta-char membership
	// check -> `false`, disabling escaping entirely) and b66506db26cf6a57
	// (the meta-char array itself -> `[]`, same effect) and
	// 856a1599ef0bb21d (`"."` removed from the array): an unescaped `.`
	// becomes a regex wildcard instead of a literal character.
	it("mutation-kill: a literal `.` in a glob pattern is escaped, not treated as a wildcard", () => {
		write({ "src/a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "src/aXts").has("foo")).toBe(false);
		expect(loadFileSuppressions(dir, "src/a.ts").has("foo")).toBe(true);
	});

	// test-contract: public-api — kills 60a5b4a3cc70fc1c (`"+"` removed from the
	// meta-char array): an unescaped `+` becomes a quantifier on the
	// preceding character instead of a literal plus sign.
	it("mutation-kill: a literal `+` in a glob pattern is escaped, not a quantifier", () => {
		write({ "ab+c": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "ab+c").has("foo")).toBe(true);
		expect(loadFileSuppressions(dir, "abbc").has("foo")).toBe(false);
	});

	// test-contract: public-api — kills c626dad9f3488f9d (`"^"` removed from the
	// meta-char array): an unescaped mid-pattern `^` is a start-of-string
	// assertion, which is unsatisfiable once other characters have already
	// been consumed — the pattern can then never match anything.
	it("mutation-kill: a literal `^` in a glob pattern is escaped, not an anchor", () => {
		write({ "a^b": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "a^b").has("foo")).toBe(true);
	});

	// test-contract: public-api — kills c549e0188074a78a (`"$"` removed from the
	// meta-char array): same contradiction as `^` above, but for the
	// end-of-string assertion.
	it("mutation-kill: a literal `$` in a glob pattern is escaped, not an anchor", () => {
		write({ "a$b": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "a$b").has("foo")).toBe(true);
	});

	// test-contract: public-api — kills 23cf969297518d2a (`"("` removed from the
	// meta-char array): an unescaped `(` with no matching `)` is an
	// unterminated regex group, which throws at `new RegExp(...)` and is
	// swallowed by the function's catch-all, turning a real match into a
	// false negative.
	it("mutation-kill: a literal `(` in a glob pattern is escaped, not a group opener", () => {
		write({ "a(b": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "a(b").has("foo")).toBe(true);
	});

	// test-contract: public-api — kills dc0a68e488f5ba7d (`")"` removed from the
	// meta-char array): a lone unescaped `)` is an unmatched-group
	// SyntaxError, same catch-swallow effect as `(` above.
	it("mutation-kill: a literal `)` in a glob pattern is escaped, not a group closer", () => {
		write({ "a)b": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "a)b").has("foo")).toBe(true);
	});

	// test-contract: public-api — kills f4d27c684a23916d (`"|"` removed from the
	// meta-char array): an unescaped `|` is alternation, splitting the
	// anchored pattern into two much broader alternatives.
	it("mutation-kill: a literal `|` in a glob pattern is escaped, not alternation", () => {
		write({ "a|b": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "a|b").has("foo")).toBe(true);
		expect(loadFileSuppressions(dir, "aXYZ").has("foo")).toBe(false);
	});

	// test-contract: public-api — kills fd0a3f50b3d4c5c3 (`"["` removed from the
	// meta-char array): an unescaped `[` with no closing `]` is an
	// unterminated character class, a genuine SyntaxError (unlike a lone
	// `]`, which JS tolerates as a literal) — caught and turned into a
	// false negative.
	it("mutation-kill: a literal `[` in a glob pattern is escaped, not a character-class opener", () => {
		write({ "a[b": { foo: { reason: "x", by: "cli", at: "n" } } });
		expect(loadFileSuppressions(dir, "a[b").has("foo")).toBe(true);
	});
});
