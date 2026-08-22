import { describe, expect, it } from "vitest";
import type { JsonObject } from "../lib/json-types.js";
import {
	type ApplyPatchSection,
	extractApplyPatchRaw,
	looksLikeApplyPatch,
	parseApplyPatchSections,
	reconstructAfterContent,
} from "./apply-patch-content.js";

describe("looksLikeApplyPatch — anchor safety", () => {
	// test-contract: mutation-kill — Regex mutant 5cb374f1552f7cf8 drops the `^`
	// anchor, which would make embedded (not line-start) directive text match.
	it("does not match a directive that is not at the start of a line", () => {
		expect(looksLikeApplyPatch("prefix *** Begin Patch")).toBe(false);
		expect(looksLikeApplyPatch("prefix *** Update File: a.ts")).toBe(false);
	});
});

describe("extractApplyPatchRaw — key precedence and type guards", () => {
	// test-contract: mutation-kill — kills 69a34bfe (patch&&->false),
	// aa2e67f (patch&&->||), b3badc4c ("string"->""), 9674ab77 (===-> !==)
	it("returns the patch field when only patch is a valid string", () => {
		const toolInput: JsonObject = { patch: "PATCH1" };
		expect(extractApplyPatchRaw(toolInput)).toBe("PATCH1");
	});

	// test-contract: mutation-kill — kills e8c7e6f2 (patch's === forced true)
	it("falls through to empty string when patch is a non-string value", () => {
		const toolInput: JsonObject = { patch: 123 };
		expect(extractApplyPatchRaw(toolInput)).toBe("");
	});

	// test-contract: mutation-kill — kills 870713be (command's === forced true)
	it("does not treat a non-string command as a match, falling through to patch", () => {
		const toolInput: JsonObject = { command: 42, patch: "PVAL" };
		expect(extractApplyPatchRaw(toolInput)).toBe("PVAL");
	});

	// test-contract: mutation-kill — kills 4a85cd8e (_raw_patch&&->false),
	// f4f1e30c (_raw_patch&&->||), d58a4d1d ("string"->""), f7a90ef0 (===->!==)
	it("returns the _raw_patch field when only it is a valid string", () => {
		const toolInput: JsonObject = { _raw_patch: "RAWVAL" };
		expect(extractApplyPatchRaw(toolInput)).toBe("RAWVAL");
	});

	// test-contract: mutation-kill — kills f067f62b (_raw_patch's === forced true)
	it("does not treat a non-string _raw_patch as a match, falling through to content", () => {
		const toolInput: JsonObject = { _raw_patch: 7, content: "CVAL" };
		expect(extractApplyPatchRaw(toolInput)).toBe("CVAL");
	});

	// test-contract: mutation-kill — kills 37e25a1b (content&&->false),
	// 10afc212 (content&&->||), 3aaa8970 ("string"->""), 5fec7a6a (===->!==)
	it("returns the content field when only it is a valid string", () => {
		const toolInput: JsonObject = { content: "CONTENTVAL" };
		expect(extractApplyPatchRaw(toolInput)).toBe("CONTENTVAL");
	});

	// test-contract: mutation-kill — kills 6312016f (content's === forced true)
	it("does not treat a non-string content as a match, falling through to empty default", () => {
		const toolInput: JsonObject = { content: 99 };
		expect(extractApplyPatchRaw(toolInput)).toBe("");
	});

	// test-contract: mutation-kill — kills c3113d36 (final "" -> "Stryker was here!")
	it("returns empty string when no recognized key carries a string", () => {
		const toolInput: JsonObject = {};
		expect(extractApplyPatchRaw(toolInput)).toBe("");
	});
});

describe("parseApplyPatchSections — trim and CRLF/anchor safety", () => {
	// test-contract: mutation-kill — kills 835f4b6c (header[2].trim() -> header[2])
	it("trims trailing whitespace from a header path", () => {
		const raw = "*** Update File: src/b.ts   \n@@\n a\n+b";
		const sections = parseApplyPatchSections(raw);
		expect(sections[0]?.path).toBe("src/b.ts");
	});

	// test-contract: mutation-kill — kills 3d663a78 (move[1].trim() -> move[1])
	it("trims trailing whitespace from a Move to destination", () => {
		const raw = ["*** Update File: src/old.ts", "*** Move to: src/new.ts   ", "@@", " a", "+b"].join(
			"\n",
		);
		const sections = parseApplyPatchSections(raw);
		expect(sections[0]?.path).toBe("src/new.ts");
	});

	// test-contract: mutation-kill — kills e60a9fd4 (the `current` truthiness
	// check on the move branch forced to `true`, which would deref a null
	// `current` when a Move to line appears with no open section).
	it("does not throw on an orphan Move to line with no current section", () => {
		const raw = "*** Move to: src/orphan.ts\n*** End Patch";
		expect(() => parseApplyPatchSections(raw)).not.toThrow();
		expect(parseApplyPatchSections(raw)).toEqual([]);
	});

	// test-contract: mutation-kill — kills 8f0e5913a (HEADER_RE drops trailing $,
	// which then also matches when a CRLF leaves a trailing \r after the path).
	it("does not treat a header line with a trailing carriage return as a match", () => {
		const raw = "*** Update File: src/a.ts\r\n@@\n a\n-x\n+y";
		expect(parseApplyPatchSections(raw)).toEqual([]);
	});

	// test-contract: mutation-kill — kills d4234def (HEADER_RE drops leading ^,
	// which would then match embedded header-shaped text inside a body line).
	it("does not treat embedded header-shaped text within a body line as a new section", () => {
		const raw = "*** Begin Patch\n*** Add File: a.ts\n+prefix *** Update File: fake.ts\n*** End Patch";
		const sections = parseApplyPatchSections(raw);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.path).toBe("a.ts");
		expect(sections[0]?.body).toEqual(["+prefix *** Update File: fake.ts"]);
	});

	// test-contract: mutation-kill — kills feb4cba2 (MOVE_RE drops leading ^,
	// which would then match embedded Move-to text inside a body line).
	it("does not treat embedded Move-to text within a body line as a retarget", () => {
		const raw = "*** Begin Patch\n*** Add File: a.ts\n+prefix *** Move to: fake.ts\n*** End Patch";
		const sections = parseApplyPatchSections(raw);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.path).toBe("a.ts");
		expect(sections[0]?.fromPath).toBeUndefined();
		expect(sections[0]?.body).toEqual(["+prefix *** Move to: fake.ts"]);
	});

	// test-contract: mutation-kill — kills 00817352 (MOVE_RE drops trailing $,
	// which then also matches when a CRLF leaves a trailing \r after the dest).
	it("does not retarget when the Move to line has a trailing carriage return", () => {
		const raw = "*** Update File: src/old.ts\n*** Move to: src/new.ts\r\n@@\n a\n+b";
		const sections = parseApplyPatchSections(raw);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.path).toBe("src/old.ts");
		expect(sections[0]?.fromPath).toBeUndefined();
	});
});

describe("reconstructAfterContent — reconstructAdd blank-line handling", () => {
	const add = (body: string[]): ApplyPatchSection => ({ op: "add", path: "a.ts", body });

	// test-contract: mutation-kill — kills e89706e8 (line.trim()==="" -> false)
	// AND 0033a00f (line.trim() -> line, dropping the trim call) simultaneously:
	// a whitespace-only (non-empty) line must still be treated as blank.
	it("treats a whitespace-only line as a blank line, not a bail-out", () => {
		const section = add(["+a", "   ", "+b"]);
		expect(reconstructAfterContent(section, "")).toBe("a\n\nb");
	});

	// test-contract: mutation-kill — kills 21072543 (pushed "" -> "Stryker was here!")
	it("preserves a genuinely empty body line as an empty output line", () => {
		const section = add(["+a", "", "+b"]);
		expect(reconstructAfterContent(section, "")).toBe("a\n\nb");
	});
});

describe("reconstructAfterContent — applyUpdateHunks / splitHunks edge cases", () => {
	const update = (body: string[]): ApplyPatchSection => ({ op: "update", path: "a.ts", body });

	// test-contract: mutation-kill — kills 715d103f (hunks.length===0 -> false)
	it("fails open (null) when the update body has no hunks at all", () => {
		expect(reconstructAfterContent(update([]), "a\nb\nc")).toBeNull();
	});

	// test-contract: mutation-kill — kills 9a6ad043 (splitHunks'
	// line.startsWith("@@") -> line.endsWith("@@")): a header-decorated marker
	// line ("@@ header text") must still split the hunk, and the mutant's
	// misrouted line then hits hunkBlocks' unknown-prefix bail.
	it("only treats a line starting with @@ as a hunk marker, not one ending with it", () => {
		const before = "x\ny\nrest";
		const section = update(["@@ header text", " x", "-y", "+z"]);
		expect(reconstructAfterContent(section, before)).toBe("x\nz\nrest");
	});

	// test-contract: mutation-kill — kills 19a000291 (final cur.length>0 -> true)
	// AND 05679de6 (final cur.length>0 -> cur.length>=0): a body ending exactly
	// on an @@ marker must not push a trailing empty hunk.
	it("does not push a spurious empty trailing hunk when the body ends on a marker", () => {
		const before = "a\nb\nc";
		const section = update([" a", "-b", "+B", "@@"]);
		expect(reconstructAfterContent(section, before)).toBe("a\nB\nc");
	});
});

describe("hunkBlocks — unknown-prefix line safety", () => {
	const update = (body: string[]): ApplyPatchSection => ({ op: "update", path: "a.ts", body });

	// test-contract: mutation-kill — kills f5fcef4d7 (line.startsWith(" ") ->
	// true) and 88dc652e (" " -> "" in that same startsWith check): an unknown-
	// prefix line must bail to null, not be silently treated as context that
	// happens to match.
	it("fails open (null) on an unknown-prefix line even when it could spuriously match as context", () => {
		const section = update(["@@", "?a", "+b"]);
		expect(reconstructAfterContent(section, "a\nrest")).toBeNull();
	});

	// test-contract: mutation-kill — kills 0270cc9a (line==="" -> true): an
	// unknown-prefix line must bail even when a blank line in before-content
	// would otherwise let a spurious empty-context match succeed.
	it("fails open (null) on an unknown-prefix line even when a blank before-line could spuriously match", () => {
		const section = update(["@@", "?x", "+y"]);
		expect(reconstructAfterContent(section, "\nrest")).toBeNull();
	});

	// test-contract: mutation-kill — kills c144e8e2 (pushed "" -> "Stryker was
	// here!" for a genuine blank context line): the real blank-context path
	// must still match a genuinely blank before-line.
	it("matches a genuinely blank context line against a blank before-line", () => {
		const section = update([" a", "", "+b"]);
		expect(reconstructAfterContent(section, "a\n\nc")).toBe("a\n\nb\nc");
	});
});
