// Mutation-kill companion for spec-quantities.ts (PASS-1 W6 survivor sweep).
// Each case targets one or more surviving mutantIds from
// .interlinked/mutation-manifest.json (file:
// src/harness/checks/spec-quantities.ts). See
// scratch/fleet-r3/receipts/spec-quantities.jsonl for the mutantId -> test
// mapping and the equivalence arguments for mutants NOT covered here.
import { describe, expect, it } from "vitest";
import { checkSpecCapacityClaims, checkSpecTableSums } from "./spec-quantities.js";

const MD = "docs/plan.md";

describe("checkSpecCapacityClaims — mutation-kill", () => {
	// test-contract: public-api — ADDRESSED_RE's "wraps?" must accept the
	// singular "wrap at" form, not only the plural "wraps at" (kills
	// mutantId 6a0ae8614a791cc7, which drops the "?").
	it("treats singular 'wrap at' as an addressed capacity claim", () => {
		const out = checkSpecCapacityClaims(
			"# D\nThe 8-bit generation field will wrap at 256 during reuse.",
			MD,
		);
		expect(out).toEqual([]);
	});

	// test-contract: public-api — ADDRESSED_RE's "explicit(?:ly)?" must accept
	// "explicit capped" without the "-ly" suffix (kills mutantId
	// 557bf4beadd2164a, which makes "ly" mandatory).
	it("treats 'explicit capped' (no -ly) as an addressed capacity claim", () => {
		const out = checkSpecCapacityClaims(
			"# D\nA 10-bit sequence counter is explicit capped to avoid reuse overflow.",
			MD,
		);
		expect(out).toEqual([]);
	});

	// test-contract: boundary — bits > 64 must stay out of range even for a
	// 2-digit value (kills a071db1996b73fd9, bd14c4256e7c07f4,
	// af1d99d98d9c7640 — all weaken the out-of-range guard).
	it("stays silent for a 65-bit field (just above the 64-bit ceiling)", () => {
		const out = checkSpecCapacityClaims("# D\nA 65-bit sequence counter tracks reuse across nodes.", MD);
		expect(out).toEqual([]);
	});

	// test-contract: boundary — bits < 2 must stay out of range (kills
	// 3888e632ec2048c0, 2de62acbe0935278, 3dbaf02883241928 — all weaken the
	// too-small guard).
	it("stays silent for a 1-bit field (below the 2-bit floor)", () => {
		const out = checkSpecCapacityClaims("# D\nA 1-bit generation flag toggles on reuse.", MD);
		expect(out).toEqual([]);
	});

	// test-contract: boundary — the MAX_MATCHES=10 cap must hold even when a
	// single line carries 11 candidate bit-fields (kills edbf8f09fb718c18
	// and c2c6c709e7dbd2cb, both of which weaken the inner break guard).
	it("caps output at 10 findings even with 11 candidate bit-fields on one line", () => {
		const bits = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
		const line = `${bits.map((b) => `${b}-bit`).join(" ")} generation counters are reused across slots.`;
		const out = checkSpecCapacityClaims(`# D\n${line}`, MD);
		expect(out).toHaveLength(10);
	});

	// test-contract: boundary — 64 is the inclusive upper bound and must still
	// be flagged (kills ff16f7ecf47c12eb, which rejects 64 too).
	it("flags a boundary 64-bit field (upper bound inclusive)", () => {
		const out = checkSpecCapacityClaims("# D\nA 64-bit sequence counter tracks reuse across nodes.", MD);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("2^64");
	});

	// test-contract: public-api — bits>=53 selects the exponent display form
	// (kills ad125d2aa5b609ce and bc78e86ffaf9e844, which both stop the
	// ternary from ever choosing the "2^N" branch at the 53 boundary).
	it("formats a 53-bit capacity using exponent form (bits>=53 boundary)", () => {
		const out = checkSpecCapacityClaims("# D\nA 53-bit sequence counter tracks reuse across shards.", MD);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("2^53");
	});

	// test-contract: boundary — 2 is the inclusive lower bound and must still
	// be flagged (kills 89e8e74164ff0dfd, which rejects 2 too).
	it("flags a boundary 2-bit field (lower bound inclusive)", () => {
		const out = checkSpecCapacityClaims("# D\nA 2-bit generation flag toggles on reuse.", MD);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("4");
	});

	// test-contract: public-api — the reported line number is the 1-indexed
	// source line, not one less (kills ff89ec89a8e0ffe9).
	it("reports the 1-indexed source line, not line-1", () => {
		const out = checkSpecCapacityClaims(
			"# Title\n\nSome preamble.\nA 4-bit generation slot is reused per epoch.\n",
			MD,
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(4);
	});
});

describe("checkSpecTableSums — mutation-kill: separator/regex boundary", () => {
	// test-contract: boundary — a leading "|---|---|"-shaped line must be
	// recognized as a separator and excluded from data rows, even when there
	// is no header row before it (kills dfb57573479911a4, 6c98b8ad1cb9cca2,
	// and 5f25d34bbe8616cb, three separate mutations of the same guard).
	it("does not misparse a leading dash/pipe row as a data row", () => {
		const table = ["|---|---|", "| a | 2 |", "| b | 3 |", "| Total | 999 |"].join("\n");
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});

	// test-contract: boundary — SEPARATOR_ROW_RE must require whitespace
	// specifically (\s), not "any non-whitespace char" — a whitespace-free
	// DATA row must not be misidentified as a separator (kills
	// 789f2c23bcf7e3e6, which flips \s to \S).
	it("does not misidentify a whitespace-free data row as a separator", () => {
		const table = [
			"| Component | Bytes |",
			"|---|---|",
			"|packed|16|",
			"| body | 48 |",
			"| tail | 8 |",
			"| Total | 72 |",
		].join("\n");
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});
});

describe("checkSpecTableSums — mutation-kill: MAX_MATCHES cap + eligibility", () => {
	// test-contract: public-api — no tables at all must return the real empty
	// array, not a placeholder-seeded one (kills 441eeb73853b1fb2).
	it("returns an empty array (not a seeded placeholder) when no tables are present", () => {
		const out = checkSpecTableSums("Just some prose with no pipe tables at all.", MD);
		expect(out).toEqual([]);
	});

	// test-contract: boundary — the MAX_MATCHES=10 cap must hold across many
	// separate mismatched tables, not just within one (kills
	// ac32ddcf55097121, 7acf22ed4cd0c468, b49c68edffde2df2, and
	// b76fcd9c7cc6964e — four separate mutations of the outer break guard).
	it("caps output at 10 findings across 11 separate mismatched tables", () => {
		const oneTable = (n: number) =>
			["| Row | Val |", "|---|---|", "| a | 1 |", "| b | 1 |", `| Total | ${100 + n} |`].join("\n");
		const tables = Array.from({ length: 11 }, (_, i) => oneTable(i)).join("\n\n");
		const out = checkSpecTableSums(tables, MD);
		expect(out).toHaveLength(10);
	});

	// test-contract: public-api — a non-spec-eligible file path must stay
	// silent even when the table content would otherwise mismatch (kills
	// 5222975f665327ee).
	it("stays silent on a non-spec-eligible file path even with a mismatched table", () => {
		const badTable = [
			"| Component | Bytes |",
			"|---|---|",
			"| header | 16 |",
			"| body | 48 |",
			"| checksum | 8 |",
			"| **Total** | 80 |",
		].join("\n");
		expect(checkSpecTableSums(badTable, "src/a.ts")).toEqual([]);
	});
});

describe("checkTable — mutation-kill", () => {
	// test-contract: boundary — the MAX_MATCHES=10 cap must hold across many
	// mismatched COLUMNS within a single table (kills a4206355af33edaf,
	// 83e0d8152484c395, d006ba7fd8202adb, and 0fee90b3adacea6d — four
	// separate mutations of checkTable's own post-push cap guard).
	it("caps output at 10 findings even with 11 mismatched columns in one table", () => {
		const cols = 11;
		const header = `| Label | ${Array.from({ length: cols }, (_, i) => `C${i}`).join(" | ")} |`;
		const sep = `|${Array.from({ length: cols + 1 }, () => "---").join("|")}|`;
		const row1 = `| a | ${Array.from({ length: cols }, () => "1").join(" | ")} |`;
		const row2 = `| b | ${Array.from({ length: cols }, () => "1").join(" | ")} |`;
		const total = `| Total | ${Array.from({ length: cols }, () => "999").join(" | ")} |`;
		const table = [header, sep, row1, row2, total].join("\n");
		const out = checkSpecTableSums(table, MD);
		expect(out).toHaveLength(10);
	});

	// test-contract: boundary — a Total cell that fails to parse as a number
	// must be skipped silently, not compared as if it were 0/null (kills
	// 06ab988f5bb0689a).
	it("skips a column whose Total cell is not numeric, without fabricating a finding", () => {
		const table = ["| Item | Amount |", "|---|---|", "| a | 10 |", "| b | 20 |", "| Total | see appendix |"].join(
			"\n",
		);
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});

	// test-contract: boundary — a table with rows but no Total/Sum label must
	// return quietly, not throw (kills 18fcfc1cb9eb4599 and 8869f2e4ad09edd1,
	// which both let checkTable run past a missing totalRow and dereference
	// undefined.cells).
	it("does not throw when a table has no Total/Sum row", () => {
		const table = ["| Item | Amount |", "|---|---|", "| a | 10 |", "| b | 20 |", "| c | 30 |"].join("\n");
		expect(() => checkSpecTableSums(table, MD)).not.toThrow();
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});

	// test-contract: boundary — a 3-row table (rows.length===3) must still be
	// checked when the Total row happens to be listed FIRST, which collapses
	// the header-exclusion and total-exclusion into a single row (kills
	// 47a191a74ff28618, which treats length===3 as "too small").
	it("still checks a 3-row table whose Total row is listed first", () => {
		const table = ["| Total | 999 |", "| a | 10 |", "| b | 20 |"].join("\n");
		const out = checkSpecTableSums(table, MD);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("states 999");
		expect(out[0]?.text).toContain("sum to 30");
	});

	// test-contract: boundary — a difference exactly AT SUM_EPSILON must be
	// treated as within tolerance (inclusive <=), not flagged (kills
	// 01d5f6a4781ef93f, which makes the bound exclusive).
	it("treats a difference exactly at SUM_EPSILON as within tolerance", () => {
		const table = ["| Item | Amount |", "|---|---|", "| a | 0 |", "| b | 0.001 |", "| Total | 0 |"].join("\n");
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});

	// test-contract: public-api — the table's first row (assumed header) must
	// be excluded from the data-row sum even if its cell looks numeric (kills
	// fc004ca4e6f72b9b, the anonymous filter callback inside checkTable).
	it("excludes the table's first row from the data-row sum even if it looks numeric", () => {
		const table = ["| Label | 999 |", "|---|---|", "| a | 10 |", "| b | 20 |", "| Total | 30 |"].join("\n");
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});
});

describe("collectTables — mutation-kill", () => {
	// test-contract: security — a stray non-table line encountered mid-scan
	// must properly close/skip its block rather than being appended as a row
	// with a null cells array, which would crash the next .find()/.filter()
	// pass over that table (kills 744e24eab9c8c307).
	it("does not append a stray non-table line as a row with a null cells array", () => {
		const content = ["| a | 10 |", "Not a table row at all.", "| b | 20 |", "| Total | 30 |"].join("\n");
		expect(() => checkSpecTableSums(content, MD)).not.toThrow();
		expect(checkSpecTableSums(content, MD)).toEqual([]);
	});
});

describe("numericCell — mutation-kill", () => {
	// test-contract: public-api — multi-digit decimals must parse in full
	// (kills fec2db20ec97443b, which requires non-digits after the dot, and
	// 13da8d0bd16a51ef, which allows only exactly one digit after the dot).
	it("parses a multi-digit decimal cell like 0.55, contributing its full value", () => {
		const table = ["| Part | Bytes |", "|---|---|", "| a | 8 |", "| b | 12 |", "| c | 0.55 |", "| Total | 20 |"].join(
			"\n",
		);
		const out = checkSpecTableSums(table, MD);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("sum to 20.55");
	});

	// test-contract: public-api — comma grouping must be STRIPPED (replaced
	// with ""), not replaced with marker text, so "1,000" still parses as
	// 1000 (kills 26b57ebdbb67618d).
	it("strips comma grouping to parse the value, not replace it with marker text", () => {
		const table = ["| Part | Count |", "|---|---|", "| a | 1,000 |", "| b | 500 |", "| c | 500 |", "| Total | 2000 |"].join(
			"\n",
		);
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});

	// test-contract: security — a non-numeric-prefixed cell ("see5") must be
	// rejected outright, not partial-matched into NaN via Number() (kills
	// d0e615539c9afd10, which drops the regex's leading "^" anchor).
	it("rejects a cell with a non-numeric prefix even if it ends in digits", () => {
		const table = [
			"| Part | Bytes |",
			"|---|---|",
			"| a | 10 |",
			"| b | 20 |",
			"| c | 30 |",
			"| d | see5 |",
			"| Total | 60 |",
		].join("\n");
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});

	// test-contract: security — a cell with trailing garbage ("5abc") must be
	// rejected outright, not partial-matched into NaN via Number() (kills
	// cb1c040814da1163, which drops the regex's trailing "$" anchor).
	it("rejects a cell with trailing garbage after a numeric prefix", () => {
		const table = [
			"| Part | Bytes |",
			"|---|---|",
			"| a | 10 |",
			"| b | 20 |",
			"| c | 30 |",
			"| d | 5abc |",
			"| Total | 60 |",
		].join("\n");
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});
});

describe("tableCells — mutation-kill (via checkSpecTableSums)", () => {
	// test-contract: boundary — a line needs BOTH a leading and a trailing
	// pipe (not just adequate length) to be treated as a table row (kills
	// cd6b49b4095f5aee, f255c2837ec3a41d, and b6e143a5d50328b0 — three
	// mutations that collapse the guard down to a length-only check).
	it("requires both a leading and trailing pipe, not just adequate length", () => {
		const content = ["| Total | 999 |", "za|99b", "| b | 20 |"].join("\n");
		expect(checkSpecTableSums(content, MD)).toEqual([]);
	});

	// test-contract: boundary — a line starting with "|" but not ending with
	// "|" must still be rejected (kills 2197f896c4f3d562, 505340d81ff798f1,
	// and 5ce2a8b020cbd660 — three mutations weakening the endsWith check).
	it("rejects a line that starts with a pipe but does not end with one", () => {
		const content = ["| a | 10 |", "| b | 20 |", "|x|99z", "| Total | 30 |"].join("\n");
		expect(checkSpecTableSums(content, MD)).toEqual([]);
	});

	// test-contract: boundary — a line ending with "|" but NOT starting with
	// "|" must still be rejected — the leading-pipe check is a real,
	// independent check (kills 0f76e9c191d12089 and 1a50d59686154918 — two
	// mutations that neutralize or duplicate the startsWith check).
	it("rejects a line that ends with a pipe but does not start with one", () => {
		const content = ["| a | 10 |", "| b | 20 |", "z | 99|", "| Total | 30 |"].join("\n");
		expect(checkSpecTableSums(content, MD)).toEqual([]);
	});

	// test-contract: boundary — a bare "|||" (length 3, a valid pipe-row one
	// char below the reject floor) must stay a separator inside its table,
	// not close the table block (kills 71473f5a4ae03db6, which relaxes the
	// length floor to <=3 and rejects it instead).
	it("keeps a table block open across a bare triple-pipe row (length-3 boundary)", () => {
		const content = ["| Total | 999 |", "|||", "| b | 20 |", "| c | 30 |"].join("\n");
		const out = checkSpecTableSums(content, MD);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("states 999");
		expect(out[0]?.text).toContain("sum to 50");
	});

	// test-contract: boundary — a bare "||" (length 2) is too short and must
	// be rejected (kills e6b7c00bc56e4e67, which disables the length check
	// entirely).
	it("rejects a bare double-pipe line (too short)", () => {
		const content = ["| Total | 999 |", "||", "| b | 20 |", "| c | 30 |"].join("\n");
		expect(checkSpecTableSums(content, MD)).toEqual([]);
	});

	// test-contract: public-api — leading/trailing whitespace around a
	// pipe-delimited row must be trimmed before the pipe check, so an
	// indented table row is still recognized (kills b43c34d2915f7a07, which
	// removes the .trim() call).
	it("trims leading/trailing whitespace before checking for pipe delimiters", () => {
		const table = [
			"| Component | Bytes |",
			"|---|---|",
			"| body | 48 |",
			"| tail | 8 |",
			"| Total | 72 |",
			"  | header | 16 |  ",
		].join("\n");
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});
});

describe("tableCells unescape — mutation-kill", () => {
	// test-contract: public-api — an escaped pipe "\|" inside a cell must
	// unescape to a literal "|" character, not be deleted outright — deleting
	// it would silently merge digit groups on either side of the escaped
	// pipe into a bogus valid number (kills e0edb605f953f982).
	it("unescapes an escaped pipe to a literal pipe, not to nothing", () => {
		const table = [
			"| Part | Bytes |",
			"|---|---|",
			"| a | 1\\|000 |",
			"| b | 5 |",
			"| c | 5 |",
			"| Total | 10 |",
		].join("\n");
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});
});
