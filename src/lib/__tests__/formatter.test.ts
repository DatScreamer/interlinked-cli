import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	badge,
	c,
	divider,
	estimateCost,
	formatTokens,
	header,
	indent,
	kvLine,
	relativeTime,
	shortTimestamp,
	stripAnsi,
	table,
	truncate,
} from "../formatter.js";

// Tests run without a TTY so ANSI wrappers short-circuit to plain strings.
// That's the production behavior in CI and `cli > file`, and what we want
// to assert for portability.

describe("stripAnsi", () => {
	it("strips a single SGR sequence", () => {
		const s = "\x1b[31mred\x1b[0m";
		expect(stripAnsi(s)).toBe("red");
	});

	it("strips multiple sequences in one string", () => {
		const s = "\x1b[1m\x1b[32mgo\x1b[0m stop\x1b[31mred\x1b[0m";
		expect(stripAnsi(s)).toBe("go stopred");
	});

	it("leaves non-ANSI text unchanged", () => {
		expect(stripAnsi("plain")).toBe("plain");
	});
});

describe("c (ANSI wrappers)", () => {
	it("returns functions for each named color", () => {
		for (const fn of [c.bold, c.dim, c.red, c.green, c.blue, c.cyan, c.yellow]) {
			expect(typeof fn).toBe("function");
		}
	});

	it("output is equivalent-visible-length to input (NO_COLOR-safe)", () => {
		// When color is disabled, the wrapper returns the raw text; when
		// enabled, stripped length still matches input length.
		expect(stripAnsi(c.bold("hi")).length).toBe(2);
		expect(stripAnsi(c.red("hello"))).toBe("hello");
	});

	it("italic/cyan/magenta/gray/white strip to the original text", () => {
		expect(stripAnsi(c.italic("i"))).toBe("i");
		expect(stripAnsi(c.cyan("c"))).toBe("c");
		expect(stripAnsi(c.magenta("m"))).toBe("m");
		expect(stripAnsi(c.gray("g"))).toBe("g");
		expect(stripAnsi(c.white("w"))).toBe("w");
	});

	it("bg* helpers strip to the original text (bgRed/bgGreen/bgYellow/bgBlue)", () => {
		expect(stripAnsi(c.bgRed("r"))).toBe("r");
		expect(stripAnsi(c.bgGreen("g"))).toBe("g");
		expect(stripAnsi(c.bgYellow("y"))).toBe("y");
		expect(stripAnsi(c.bgBlue("b"))).toBe("b");
	});

	it("ansi()-based and bg* helpers take both branches of the supportsColor ternary", async () => {
		// `supportsColor` is computed once at module load from
		// process.stdout.isTTY / NO_COLOR / CI, so we force both states by
		// stubbing isTTY and re-importing the module fresh each time.
		const originalIsTTY = process.stdout.isTTY;
		try {
			vi.resetModules();
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			vi.stubEnv("NO_COLOR", "");
			vi.stubEnv("CI", "");
			const colored = await import("../formatter.js");
			expect(colored.c.bgRed("x")).toBe("\x1b[41m\x1b[37mx\x1b[0m");
			expect(colored.c.bgGreen("x")).toBe("\x1b[42m\x1b[30mx\x1b[0m");
			expect(colored.c.bgYellow("x")).toBe("\x1b[43m\x1b[30mx\x1b[0m");
			expect(colored.c.bgBlue("x")).toBe("\x1b[44m\x1b[37mx\x1b[0m");
			expect(colored.c.bold("x")).toBe("\x1b[1mx\x1b[0m");

			vi.resetModules();
			Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
			const plain = await import("../formatter.js");
			expect(plain.c.bgRed("x")).toBe("x");
			expect(plain.c.bgGreen("x")).toBe("x");
			expect(plain.c.bgYellow("x")).toBe("x");
			expect(plain.c.bgBlue("x")).toBe("x");
			expect(plain.c.bold("x")).toBe("x");
		} finally {
			Object.defineProperty(process.stdout, "isTTY", {
				value: originalIsTTY,
				configurable: true,
			});
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});
});

describe("truncate", () => {
	it("returns input unchanged when it fits", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("appends an ellipsis when exceeding maxLen", () => {
		const out = truncate("0123456789abcdef", 6);
		expect(out.endsWith("…")).toBe(true);
		expect(stripAnsi(out).length).toBeLessThanOrEqual(6);
	});

	it("returns empty string when maxLen <= 0", () => {
		expect(truncate("abc", 0)).toBe("");
	});

	it("preserves ANSI sequences during truncation (no broken sequences)", () => {
		const s = c.red("abcdefghij");
		const out = truncate(s, 5);
		// The truncated output should either have no escape sequences or end
		// with a reset after the ellipsis — never a dangling open sequence.
		const ansiReset = `${String.fromCharCode(0x1b)}[0m`;
		const endsClean = out.endsWith("…") || out.endsWith(`…${ansiReset}`);
		expect(endsClean).toBe(true);
	});
});

describe("indent", () => {
	it("indents every line by `spaces` characters", () => {
		expect(indent("a\nb\nc", 2)).toBe("  a\n  b\n  c");
	});

	it("defaults to 2 spaces", () => {
		expect(indent("a").startsWith("  ")).toBe(true);
	});
});

describe("divider / header / kvLine", () => {
	it("divider produces the requested width + char", () => {
		expect(stripAnsi(divider("=", 5))).toBe("=====");
	});

	it("header has the title on first line and a rule below", () => {
		const out = stripAnsi(header("Status"));
		const lines = out.split("\n");
		expect(lines[1]).toBe("Status");
		expect(lines[2]).toBe("──────");
	});

	it("kvLine renders `  key           value`", () => {
		const out = stripAnsi(kvLine("mode", "json"));
		expect(out).toMatch(/^ {2}mode\s+json$/);
	});
});

describe("table", () => {
	it("renders the header row", () => {
		const out = stripAnsi(table(["Col"], [["x"]]));
		expect(out).toMatch(/Col/);
		expect(out).toMatch(/x/);
	});

	it("renders `(none)` when there are no rows", () => {
		expect(stripAnsi(table(["Col"], []))).toMatch(/\(none\)/);
	});

	it("does not truncate a cell even when maxWidth caps the computed column width below it", () => {
		// maxWidth caps the computed column width below the actual cell
		// length, so `widths[i] - stripped.length` goes negative and the
		// Math.max(0, ...) clamp in the padding calc must kick in.
		const out = table(["Col"], [["a-very-long-cell-value"]], { maxWidth: 3 });
		const lines = stripAnsi(out).split("\n");
		expect(lines[2]).toBe("a-very-long-cell-value");
	});

	it("treats a missing cell (row shorter than headers) as empty when measuring width", () => {
		const out = stripAnsi(table(["A", "B"], [["only-a"]]));
		const lines = out.split("\n");
		// Header row still renders both columns; the short row's missing `B`
		// cell falls back to "" rather than throwing.
		expect(lines[0]).toBe("A       B");
	});

	it("clamps padding to 0 for a cell with no corresponding header (row longer than headers)", () => {
		const out = stripAnsi(table(["A"], [["a", "extra"]]));
		const lines = out.split("\n");
		// `extra` has no width entry, so its own padding falls back to 0 (no
		// trailing spaces on that cell) — only the fixed 2-space column
		// separator appears between it and `a`.
		expect(lines[2]).toBe("a  extra");
	});

	it("columns align to the longest cell", () => {
		const out = stripAnsi(
			table(
				["A", "B"],
				[
					["short", "shorter"],
					["lengthier", "x"],
				],
			),
		);
		const lines = out.split("\n");
		// Header width matches the longest cell in each column.
		expect(lines[0].indexOf("B")).toBeGreaterThan("lengthier".length);
	});
});

describe("badge", () => {
	it("returns a bracketed status for known labels", () => {
		expect(stripAnsi(badge("online"))).toBe("[online]");
		expect(stripAnsi(badge("error"))).toBe("[error]");
	});

	it("urgent gets background-color variant (spaced, no brackets)", () => {
		expect(stripAnsi(badge("urgent"))).toBe(" urgent ");
	});

	it("unknown statuses get the dim default", () => {
		expect(stripAnsi(badge("mystery"))).toBe("[mystery]");
	});

	it("covers every case label in the switch (green/dim/yellow/blue/red groups)", () => {
		expect(stripAnsi(badge("active"))).toBe("[active]");
		expect(stripAnsi(badge("completed"))).toBe("[completed]");
		expect(stripAnsi(badge("done"))).toBe("[done]");
		expect(stripAnsi(badge("offline"))).toBe("[offline]");
		expect(stripAnsi(badge("inactive"))).toBe("[inactive]");
		expect(stripAnsi(badge("deactivated"))).toBe("[deactivated]");
		expect(stripAnsi(badge("pending"))).toBe("[pending]");
		expect(stripAnsi(badge("waiting"))).toBe("[waiting]");
		expect(stripAnsi(badge("in_progress"))).toBe("[in_progress]");
		expect(stripAnsi(badge("working"))).toBe("[working]");
		expect(stripAnsi(badge("blocked"))).toBe("[blocked]");
		expect(stripAnsi(badge("failed"))).toBe("[failed]");
	});

	it("is case-insensitive via toLowerCase", () => {
		expect(stripAnsi(badge("ONLINE"))).toBe("[ONLINE]");
	});
});

describe("relativeTime", () => {
	// `relativeTime` reads `Date.now()` internally via `new Date()`. We freeze
	// the clock with fake timers so both the test's reference `now` and the
	// function's internal `now` see the same instant — making the seconds/
	// minutes/hours/days arithmetic exact rather than racing real wall time.
	const FROZEN_NOW = 1_700_000_000_000;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(FROZEN_NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns `never` for null/undefined", () => {
		expect(stripAnsi(relativeTime(null))).toBe("never");
		expect(stripAnsi(relativeTime(undefined))).toBe("never");
	});

	it("returns `just now` for future timestamps", () => {
		const future = new Date(FROZEN_NOW + 60_000).toISOString();
		expect(relativeTime(future)).toBe("just now");
	});

	it("renders seconds / minutes / hours / days", () => {
		expect(relativeTime(new Date(FROZEN_NOW - 30_000).toISOString())).toMatch(/^\d+s ago$/);
		expect(relativeTime(new Date(FROZEN_NOW - 10 * 60_000).toISOString())).toMatch(
			/^\d+m ago$/,
		);
		expect(relativeTime(new Date(FROZEN_NOW - 5 * 60 * 60_000).toISOString())).toMatch(
			/^\d+h ago$/,
		);
		expect(relativeTime(new Date(FROZEN_NOW - 3 * 24 * 60 * 60_000).toISOString())).toMatch(
			/^\d+d ago$/,
		);
	});

	it("falls back to a localized date string past 30 days", () => {
		const old = new Date(FROZEN_NOW - 90 * 24 * 60 * 60_000);
		expect(relativeTime(old.toISOString())).toBe(old.toLocaleDateString());
	});
});

describe("shortTimestamp", () => {
	it("returns empty string for null/undefined", () => {
		expect(shortTimestamp(null)).toBe("");
		expect(shortTimestamp(undefined)).toBe("");
	});

	it("returns HH:MM form", () => {
		const iso = new Date("2026-04-22T13:45:00Z").toISOString();
		expect(shortTimestamp(iso)).toMatch(/^\d{2}:\d{2}$/);
	});
});

describe("formatTokens / estimateCost", () => {
	it("formatTokens renders input/output with k suffix past 1000", () => {
		expect(formatTokens({ input: 2500, output: 900 })).toBe("2.5k in / 900 out");
	});

	it("formatTokens returns `0 tokens` when all are absent", () => {
		expect(formatTokens({})).toBe("0 tokens");
	});

	it("formatTokens omits the `out` segment when output is absent", () => {
		expect(formatTokens({ input: 500 })).toBe("500 in");
	});

	it("formatTokens includes the `cache` segment when cache_read is present", () => {
		expect(formatTokens({ input: 500, cache_read: 1200 })).toBe("500 in / 1.2k cache");
	});

	it("estimateCost includes a `$` prefix", () => {
		expect(estimateCost({ input: 1000, output: 500 })).toMatch(/^~\$/);
	});

	it("estimateCost treats a missing input/output/cache_read as 0 cost contribution", () => {
		// Same fields present in both calls; omitting one must produce the
		// identical result to passing it as 0 (the `|| 0` fallback arm), for
		// each of the three fields independently.
		expect(estimateCost({ output: 500 })).toBe(estimateCost({ input: 0, output: 500 }));
		expect(estimateCost({ input: 1000 })).toBe(estimateCost({ input: 1000, output: 0, cache_read: 0 }));
	});

	it("estimateCost renders 4 decimal places under $0.01", () => {
		expect(estimateCost({ input: 1 })).toBe("~$0.0000");
	});

	it("opus pricing is higher than sonnet for the same tokens", () => {
		const s = Number.parseFloat(
			estimateCost({ input: 100_000, output: 50_000 }).replace(/[^\d.]/g, ""),
		);
		const o = Number.parseFloat(
			estimateCost({ input: 100_000, output: 50_000 }, "opus-4").replace(/[^\d.]/g, ""),
		);
		expect(o).toBeGreaterThan(s);
	});
});
