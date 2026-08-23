import { describe, expect, it } from "vitest";
import { NODE_FETCH_FOOTGUNS } from "./node-fetch.js";

const FILE = "app.ts";

const noTimeout = (content: string) => NODE_FETCH_FOOTGUNS[0]!.detect(content, FILE);
const noOkCheck = (content: string) => NODE_FETCH_FOOTGUNS[1]!.detect(content, FILE);

describe("NODE_FETCH_FOOTGUNS export shape — kills object/array/string-literal mutants", () => {
	it("has exactly two entries", () => {
		expect(NODE_FETCH_FOOTGUNS).toHaveLength(2);
	});

	it("first entry is the no-timeout check with a real detector", () => {
		const entry = NODE_FETCH_FOOTGUNS[0]!;
		expect(entry.id).toBe("node_fetch_no_timeout");
		expect(entry.name).toBeTruthy();
		expect(entry.library).toBe("node-fetch");
		expect(entry.fixInstruction).toBeTruthy();
		expect(typeof entry.detect).toBe("function");
		expect(noTimeout("fetch(url)")).toHaveLength(1);
	});

	it("second entry is the no-ok-check check with a real detector", () => {
		const entry = NODE_FETCH_FOOTGUNS[1]!;
		expect(entry.id).toBe("node_fetch_no_ok_check");
		expect(entry.name).toBeTruthy();
		expect(entry.library).toBe("node-fetch");
		expect(entry.fixInstruction).toBeTruthy();
		expect(typeof entry.detect).toBe("function");
		expect(noOkCheck("fetch(u).then(r=>r.json()")).toHaveLength(1);
	});
});

describe("detectNoTimeout / isInitPassThrough — kills regex + boolean mutants", () => {
	it("matches fetch() calls even with a space before the paren", () => {
		// FETCH_CALL_RE: fetch\s*\( — a `\S*` mutant would refuse this call
		// entirely, silently dropping the finding.
		expect(noTimeout("fetch (url)")).toHaveLength(1);
	});

	it("a multi-arg spread whose first part looks like a spread is NOT pass-through by itself", () => {
		// parts.length === 1 must gate the spread-shortcut branch; with two
		// parts (spread + a non-empty object literal that fails the second
		// regex) the call must still be flagged.
		expect(noTimeout("fetch(...args, {foo: 1})")).toHaveLength(1);
	});

	it("a single arg that only starts with a spread pattern (trailing junk) is not pass-through", () => {
		// /^\.\.\.[\w$]+$/ requires the WHOLE arg to be the spread — trailing
		// garbage after the identifier must not match (kills $-anchor removal).
		expect(noTimeout("fetch(...args!)")).toHaveLength(1);
	});

	it("a single arg with a spread pattern NOT at the start is not pass-through", () => {
		// The ^ anchor must force the match to start at position 0 (kills
		// ^-anchor removal, which would let a later `...args` match count).
		expect(noTimeout("fetch(xxx...args)")).toHaveLength(1);
	});

	it("a second arg that is an identifier plus trailing junk is not pass-through", () => {
		// The bare-identifier regex's trailing $ must be enforced.
		expect(noTimeout("fetch(url, opts!)")).toHaveLength(1);
	});

	it("a second arg using `identifier ?? {}` with zero interior whitespace is pass-through", () => {
		// Both \s* around `??` must accept zero whitespace.
		expect(noTimeout("fetch(url, opts??{})")).toHaveLength(0);
	});

	it("a second arg using `identifier ?? value` (multi-char identifier value) is pass-through", () => {
		// The value alternative must be [\w$]+ (one-or-more identifier chars),
		// not a single char or a negated class.
		expect(noTimeout("fetch(url, opts??val)")).toHaveLength(0);
	});

	it("a second arg using `identifier ?? { }` with whitespace inside the braces is pass-through", () => {
		// \{\s*\} must accept whitespace between the braces, not \S*.
		expect(noTimeout("fetch(url, opts ?? { })")).toHaveLength(0);
	});
});

describe("detectNoOkCheck — kills window-bounds and regex-whitespace mutants", () => {
	it("does not treat a far-away `.ok` (outside the 100-char window) as a guard", () => {
		const filler = "z".repeat(400);
		const content = `fetch(a).then(r => r.json()\n${filler}\nr.ok`;
		// The real `.ok` sits ~400 chars past the match; Math.min(...) / the
		// windowed slice must exclude it, so this must still be flagged.
		expect(noOkCheck(content)).toHaveLength(1);
	});

	it("does not lose a nearby `.ok` guard to a corrupted (negative) window end", () => {
		const content = "fetch(b).then(r => r.json() r.ok";
		// `.ok` sits right after the match, well within any correct window.
		// A mutant that computes the window end via `m.index - m[0].length`
		// produces a negative end, collapsing the window to just "fetch(" —
		// which would wrongly flag this as unchecked.
		expect(noOkCheck(content)).toHaveLength(0);
	});

	it("truncates the reported line text to 150 characters", () => {
		const filler = "x".repeat(200);
		const content = `fetch(c).then(r => r.json()); ${filler}`;
		const result = noOkCheck(content);
		expect(result).toHaveLength(1);
		expect(content.length).toBeGreaterThan(150);
		expect(result[0]!.text.length).toBe(150);
	});

	it("matches the fetch-then-json shape with whitespace at every optional position", () => {
		const content = "fetch (x) .then ( r => r.json (";
		// Every \s* in FETCH_THEN_JSON_RE is exercised with a real space here;
		// any of them turned into \S* would break the match entirely.
		expect(noOkCheck(content)).toHaveLength(1);
	});

	it("matches the fetch-then-json shape with zero whitespace at every optional position", () => {
		const content = "fetch(x).then(r=>r.json()";
		// The \s* right before `=>` and right after it must accept ZERO
		// whitespace — a mutant requiring \s (one-or-more) would break this
		// tight, common form.
		expect(noOkCheck(content)).toHaveLength(1);
	});
});
