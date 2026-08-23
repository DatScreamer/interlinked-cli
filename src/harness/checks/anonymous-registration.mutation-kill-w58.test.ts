import { describe, expect, it } from "vitest";
import { checkAnonymousRegistration } from "./anonymous-registration.js";

const FILE = "src/some-registry.ts";

describe("checkAnonymousRegistration — comment-line detection", () => {
  // test-contract: public-api — isCommentLine must trim leading whitespace so an
  // indented `//` line is still recognized as a comment, not a registration line.
  it("P1: an indented `//` comment is skipped (trimStart, not trimEnd)", () => {
    const content = ['const registry = { id: "x" };', "   // fn: (a) => {}"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(0);
  });

  // test-contract: public-api — isCommentLine treats a `*` block-comment
  // continuation as a comment via startsWith, independent of what it ends with.
  it("P2: a `*` block-comment continuation line is skipped (startsWith, not endsWith)", () => {
    const content = ['const registry = { id: "x" };', "* handler: (x) => {}"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(0);
  });

  // test-contract: public-api — isCommentLine recognizes `/* ... */` by its
  // opening token via startsWith, not by what the line happens to end with.
  it("P3: a `/* ... */` single-line comment is skipped (startsWith, not endsWith)", () => {
    const content = ['const registry = { id: "x" };', "/* handler: (x) => {} */"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(0);
  });
});

describe("checkAnonymousRegistration — entry window boundary", () => {
  // test-contract: boundary — ENTRY_WINDOW_LINES is an inclusive bound: a gap of
  // exactly 12 lines from the key must still be treated as "in range".
  it("P4: an anon impl exactly ENTRY_WINDOW_LINES (12) after the key still counts", () => {
    const lines: string[] = ['const e = { id: "x" };'];
    for (let i = 0; i < 11; i++) lines.push(`const filler${i} = 1;`);
    lines.push("fn: (a) => {}"); // index 12
    const result = checkAnonymousRegistration(lines.join("\n"), FILE);
    expect(result).toHaveLength(1);
    expect(result[0]?.line).toBe(13);
  });

  // test-contract: invariant — an anonymous-impl-shaped line far outside the
  // ENTRY_WINDOW_LINES window from any key must not be reported as a match.
  it("N1: an anon impl well beyond the window (gap 20) is not flagged", () => {
    const lines: string[] = ['const e = { id: "x" };'];
    for (let i = 0; i < 19; i++) lines.push(`const filler${i} = 1;`);
    lines.push("fn: (a) => {}"); // index 20, gap 20
    expect(checkAnonymousRegistration(lines.join("\n"), FILE)).toHaveLength(0);
  });

  // test-contract: invariant — the detector requires BOTH a lookup key and an
  // anon-impl shape; an anon-impl-shaped line with no key present anywhere in
  // the file must never be reported (the check is doc'd as narrow-by-design).
  it("N2: an anon impl pattern with no key anywhere is never flagged", () => {
    const content = "fn: (a) => {}";
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(0);
  });

  // test-contract: public-api — the window distance is (i - lastKeyLine): a line
  // immediately after a key placed late in the file (large absolute index) must
  // still count as gap 1, not be rejected by a spurious i + lastKeyLine sum.
  it("P5: an anon impl right after a distant key uses (i - lastKeyLine), not (i + lastKeyLine)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`const filler${i} = 1;`);
    lines.push('const e = { id: "x" };'); // index 20
    lines.push("fn: (a) => {}"); // index 21, gap 1
    const result = checkAnonymousRegistration(lines.join("\n"), FILE);
    expect(result).toHaveLength(1);
    expect(result[0]?.line).toBe(22);
  });
});

describe("checkAnonymousRegistration — MATCH_LIMIT", () => {
  // test-contract: boundary — MATCH_LIMIT (10) must cap the result array exactly
  // at 10 when more than 10 candidate lines exist, neither 11 nor unbounded.
  it("P6: caps at exactly 10 matches, not 11 or unbounded", () => {
    const lines: string[] = [];
    for (let k = 0; k < 12; k++) {
      lines.push(`const e${k} = { id: "k${k}" };`);
      lines.push("fn: (a) => {}");
    }
    const result = checkAnonymousRegistration(lines.join("\n"), FILE);
    expect(result).toHaveLength(10);
  });
});

describe("checkAnonymousRegistration — recorded text", () => {
  // test-contract: public-api — InlineMatch.text is documented as the matched
  // line's content; it must be trimmed, not the raw padded source line.
  it("P7: recorded text is trimmed of surrounding whitespace", () => {
    const content = ['const registry = { id: "x" };', "   fn: (a) => {},   "].join("\n");
    const result = checkAnonymousRegistration(content, FILE);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("fn: (a) => {},");
  });

  // test-contract: boundary — InlineMatch.text must be capped at 150 chars so a
  // very long source line does not blow up the finding payload.
  it("P8: recorded text is truncated to 150 chars for a long line", () => {
    const filler = "a".repeat(300);
    const implLine = `fn: (a) => {}; ${filler}`;
    const content = ['const registry = { id: "x" };', implLine].join("\n");
    const result = checkAnonymousRegistration(content, FILE);
    expect(result).toHaveLength(1);
    expect(result[0]?.text.length).toBe(150);
  });
});

describe("checkAnonymousRegistration — LOOKUP_KEY_RE regex shape", () => {
  // test-contract: public-api — LOOKUP_KEY_RE allows arbitrary whitespace (\s*)
  // between the `id`/`name` token and the colon, per the documented pattern.
  it("P9: `id :` with a space before the colon is a valid key", () => {
    const content = ['id : "x"', "fn: (a) => {}"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(1);
  });

  // test-contract: public-api — LOOKUP_KEY_RE allows zero whitespace (\s*)
  // between the colon and the opening quote, per the documented pattern.
  it("P10: `id:` with no space before the quote is a valid key", () => {
    const content = ['id:"x"', "fn: (a) => {}"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(1);
  });
});

describe("checkAnonymousRegistration — ANON_IMPL_RE regex shape", () => {
  // test-contract: public-api — ANON_IMPL_RE allows zero whitespace (\s*) after
  // the key token's colon before the implementation shape begins.
  it("P11: `fn:(a)` with no space after the colon matches", () => {
    const content = ['const e = { id: "x" };', "fn:(a) => {}"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(1);
  });

  // test-contract: public-api — ANON_IMPL_RE allows whitespace (\s*) between the
  // fn/handler/etc. token and its colon, per the documented pattern.
  it("P12: `fn :` with a space before the colon matches", () => {
    const content = ['const e = { id: "x" };', "fn : (a) => {}"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(1);
  });

  // test-contract: public-api — ANON_IMPL_RE's async marker requires one-or-more
  // whitespace (\s+), so multiple spaces after `async` must still match.
  it("P13: `async` followed by two spaces still matches", () => {
    const content = ['const e = { id: "x" };', "fn: async  (a) => {}"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(1);
  });

  // test-contract: public-api — the standard `async (` form (single space) is
  // the common case the async-marker group must accept.
  it("P14: `async` followed by one space matches", () => {
    const content = ['const e = { id: "x" };', "fn: async (a) => {}"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(1);
  });

  // test-contract: public-api — ANON_IMPL_RE allows zero whitespace (\s*)
  // between `function` and its opening paren, per the documented pattern.
  it("P15: `function(a)` with no space after `function` matches", () => {
    const content = ['const e = { id: "x" };', "fn: function(a) {}"].join("\n");
    expect(checkAnonymousRegistration(content, FILE)).toHaveLength(1);
  });
});
