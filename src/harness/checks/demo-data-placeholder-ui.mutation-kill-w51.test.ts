import { describe, expect, it } from "vitest";
import { checkPlaceholderDataInUi } from "./demo-data-placeholder-ui.js";

const FILE = "src/components/Widget.tsx";

describe("checkPlaceholderDataInUi — mutation-kill w51", () => {
	// Kills f42eda7813e53004 (ConditionalExpression `host` -> `false` in
	// placeholderSignalOnLine). The image-host branch must actually fire and
	// short-circuit the segment loop — the URL text itself contains no other
	// placeholder signal (no mock/fake ident, no lorem/here copy, digits "300"
	// are not placeholder-shaped), so if the `if (host)` guard is neutered the
	// finding disappears entirely.
	it("P1: flags a known filler-image host even when the rest of the line is clean", () => {
		const content = '<img src="https://placehold.co/300" alt="banner" />';
		const matches = checkPlaceholderDataInUi(content, FILE);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("placeholder image host");
	});

	it("N1: a non-filler image host produces no finding", () => {
		const content = '<img src="https://example.com/300" alt="banner" />';
		const matches = checkPlaceholderDataInUi(content, FILE);
		expect(matches.length).toBe(0);
	});

	// Kills 48cb7c9c1da995af (MethodExpression `.trim()` removed from
	// `nonNull(originalLines[j]).trim()` inside markedNumberDetail's blank-line
	// lookback). A whitespace-only line ("   ") must be treated as blank and
	// skipped so the lookback reaches the real marker line two lines back.
	// Without .trim(), the whitespace line fails the `=== ""` check, so the
	// lookback stops there instead of skipping past it, and the real marker
	// on the earlier line is never consulted.
	it("P2: looks past a whitespace-only line to find a marker comment two lines back", () => {
		const content = ["// hardcoded value", "   ", "<div>{78321}</div>"].join("\n");
		const matches = checkPlaceholderDataInUi(content, FILE);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("hardcoded number a comment marks as placeholder");
	});

	it("N2: a genuinely blank (no marker) lookback line yields no finding", () => {
		const content = ["// nothing special here", "   ", "<div>{78321}</div>"].join("\n");
		const matches = checkPlaceholderDataInUi(content, FILE);
		expect(matches.length).toBe(0);
	});

	// Kills cd680970c96b4da9 (UnaryOperator `-1` -> `+1` in commentTextOf).
	// The comment span must start exactly at the true first differing
	// position. If `min` is instead seeded/compared against the wrong
	// constant, the recovered "comment text" can spuriously include code
	// that precedes the real comment — e.g. an identifier named
	// `hardcoded` sitting in the code portion of the line, which the
	// correct implementation would never include in the comment span
	// (the real comment here is only "// ok", which contains no marker).
	it("P3: does not read a marker word out of the code portion of the line", () => {
		const content = "const hardcoded = <span>{78321}</span>; // ok";
		const matches = checkPlaceholderDataInUi(content, FILE);
		expect(matches.length).toBe(0);
	});

	// Direct positive control for the same function: a real inline marker
	// comment on the very line with the number must be detected. This also
	// guards against a broken `min === -1` comparison collapsing
	// commentTextOf to always return "".
	it("P4: detects a marker comment on the same line as the rendered number", () => {
		const content = "<div>{78321}</div> // hardcoded value";
		const matches = checkPlaceholderDataInUi(content, FILE);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("hardcoded number a comment marks as placeholder");
	});

	// Kills 462ea3313a236893 (Regex `\s+` -> `\S+` inside the "your X Y here"
	// alternative of PLACEHOLDER_COPY_RE). Two real words separated by a
	// double space between "your" and "here" only match when the connector
	// is whitespace (`\s+`); `\S+` (non-whitespace) can never span an actual
	// space character, so the mutant regex fails to match this rendered
	// text while the real detector must flag it.
	it("P5: flags 'your <word>  <word> here' placeholder copy with irregular spacing", () => {
		const content = "<p>your name  address here</p>";
		const matches = checkPlaceholderDataInUi(content, FILE);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("placeholder copy");
	});

	it("N5: ordinary prose containing 'your' and 'here' with no filler shape is not flagged", () => {
		const content = "<p>your account balance is available here</p>";
		// "balance is available" is 3 words between "your" and "here" — outside
		// the (optional single word) grammar, so this must not match.
		const matches = checkPlaceholderDataInUi(content, FILE);
		expect(matches.length).toBe(0);
	});
});
