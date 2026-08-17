import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCircularImports, checkDefaultExport, checkLifecycleCleanup } from "./agent-safety-advanced.js";

// Fleet W6 residue-kill campaign (2026-08-12, second pass 2026-08-14) —
// targets survivors of src/harness/checks/agent-safety-advanced.ts (see
// scratch/fleet-r3/receipts/src_harness_checks_agent-safety-advanced.ts.jsonl
// for the full per-mutant ledger, including corrections below). The 2026-08-14
// pass found the manifest's ordinalWithinSymbol/siteId fields disambiguate
// same-lexeme occurrences that naive text-occurrence scanning conflates —
// THREE of the eight cases below were previously misclassified killed_by_test
// by an earlier receipt (wrong occurrence attribution) and are actually
// equivalent_candidate (see the receipts ledger: 2f858580720a6486,
// 120350afc53d3311, 9de0aa66a259b5cc). The `i+1` named-mismatch case was
// added 2026-08-14 to close a genuine gap the earlier pass missed (a second,
// independent `i + 1` site the anonymous-only fixture never reaches). The
// remaining ~30 open survivors are equivalent_candidate via redundant/
// nullified guards or unreachable regex branches — see the receipts file.

describe("checkCircularImports — mutant-kill: .js is a recognized extension", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "il-w6-cyc-js-"));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P: detects a two-file cycle between .js files, not just .ts/.tsx/.jsx/.mjs/.cjs/.mts/.cts", () => {
		// Guards a StringLiteral mutant that replaces the literal ".js" in the
		// extension allow-list with "" — under the mutant, ".js" is no longer a
		// member of the array, so every .js file is silently treated as
		// non-JS/TS and skipped (returns [] even for a real cycle).
		const aPath = join(dir, "a.js");
		const aContent = 'import { b } from "./b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(join(dir, "b.js"), 'import { a } from "./a.js";\nexport const b = () => a();\n');
		const out = checkCircularImports(aContent, aPath, dir);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe("import cycle: a.js → b.js → a.js");
	});
});

describe("checkDefaultExport — mutant-kill: extends-clause whitespace and line-number math", () => {
	it("P: 2+ spaces between `extends` and the superclass name is still the anonymous-class shape, not a bogus named-form capture", () => {
		// Guards a Regex mutant on ANON_FORMS[2]'s extends alternative
		// (extends\s+\S+ -> extends\s\S+). With 2+ spaces there, the mutant's
		// exactly-one-whitespace `\s` can't reach a non-whitespace `\S+` start,
		// so the whole extends group fails, the anonymous-class pattern never
		// matches, and NAMED_FORM's own (unmutated) capture greedily grabs the
		// literal word "extends" as if it were the class name — a completely
		// different finding, not just a different match count.
		const out = checkDefaultExport("export default class extends  Base {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"anonymous default export: export default class extends  Base {}",
		);
	});

	it("P: the anonymous-export finding reports line i+1, not i-1, for the first line of the file", () => {
		// Guards an ArithmeticOperator mutant (i + 1 -> i - 1) on the reported
		// line number. Using the very first line (i=0) makes i+1=1 and i-1=-1
		// maximally distinguishable — no line-count arithmetic needed to see
		// the divergence.
		const out = checkDefaultExport("export default function () { return 1; }\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(1);
	});

	it("P: the named-mismatch finding ALSO reports line i+1, not i-1 — a SEPARATE i+1 site from the anonymous branch", () => {
		// The anonymous-branch test above only guards the manifest's ordinal-0
		// `i + 1` site (inside the ANON_FORMS push). The named-mismatch branch
		// a few lines down has its OWN independent `line: i + 1` (ordinal 1) —
		// a distinct Stryker mutant that a single-line anonymous fixture can
		// never reach, since it never executes the named-form push at all.
		const out = checkDefaultExport("export default function widget() { return 1; }\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(1);
		expect(out[0]?.text).toContain("does not match filename");
	});
});

describe("checkLifecycleCleanup — mutant-kill: violation-message labels and the per-pair 10-match cap", () => {
	it("P: an unclosed setTimeout's own label text appears in the violation message", () => {
		// Guards a StringLiteral mutant that empties PAIRS' `label: "setTimeout"`
		// entry. The label is embedded directly in the pushed finding's text
		// (`${pair.label}() without matching ...`), so an emptied label is
		// observable there even though the detection regex itself is untouched.
		const code = "class P {\n  start() { setTimeout(f, 1); }\n  stop() { this.x = 1; }\n}\n";
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"setTimeout() without matching clearTimeout in lifecycle method: start() { setTimeout(f, 1); }",
		);
	});

	it("P: an unclosed addEventListener's own label text appears in the violation message", () => {
		// Same class of mutant as the setTimeout case above, on PAIRS'
		// `label: "addEventListener"` entry.
		const code = [
			"class View {",
			"  mount() { window.addEventListener('resize', this.onResize); }",
			"  unmount() { this.done = true; }",
			"}",
		].join("\n");
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"addEventListener() without matching removeEventListener in lifecycle method: mount() { window.addEventListener('resize', this.onResize); }",
		);
	});

	it("P: the PAIRS-loop's own 10-match cap stops mid-class, independent of the outer class-loop's cap", () => {
		// Guards a ConditionalExpression + EqualityOperator pair of mutants on
		// PAIRS' own `if (matches.length >= 10) break;` (distinct from the
		// class-loop's identically-worded guard a few lines up — this fixture
		// isolates the PAIRS-loop occurrence specifically). 9 filler classes
		// fill the cap to 9; a 10th class with THREE simultaneous unclosed
		// subscriptions must contribute exactly ONE more (10 total) — under
		// either mutant the PAIRS loop keeps evaluating all three pairs in
		// that class instead of stopping, producing 12.
		const filler = Array.from({ length: 9 }, (_, i) =>
			[`class Filler${i} {`, "  start() { setInterval(f, 1); }", "  stop() { this.x = 1; }", "}"].join(
				"\n",
			),
		).join("\n\n");
		const overloaded = [
			"class Overloaded {",
			"  start() {",
			"    setInterval(f, 1);",
			"    setTimeout(g, 1);",
			"    window.addEventListener('x', h);",
			"  }",
			"  stop() { this.x = 1; }",
			"}",
		].join("\n");
		const code = `${filler}\n\n${overloaded}`;
		const out = checkLifecycleCleanup(code, "src/many-pairs.ts");
		expect(out.length).toBe(10);
	});

	it("P: the reported line number depends on a real newline count in the ORIGINAL source, not a blanked one", () => {
		// Guards a StringLiteral mutant on `matches.length >= 10 ... "\n"` — the
		// separator used to count newlines before the violation's absolute
		// offset (`stripped.slice(0, absOffset).match(/\n/g)`). Emptying the
		// search string breaks the newline count, which corrupts the reported
		// line number for any violation past line 1.
		const code =
			"class Poller {\n  start() { this.id = setInterval(() => this.tick(), 1000); }\n  stop() { this.running = false; }\n}";
		const out = checkLifecycleCleanup(code, "src/poller.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(2);
	});

	// test-contract: bug — round-1 receipt 9de0aa66a259b5cc wrongly reasoned
	// this StringLiteral mutant ("\n" -> "") is unreachable via the newline-
	// count regex (`/\n/g`, a different literal). The actually-mutated site is
	// `content.split("\n")` a few lines up: split("") turns `originalLines`
	// into a per-CHARACTER array, so `originalLines[lineIdx]` under the mutant
	// returns a single character instead of the violation's source line. The
	// existing `.line` assertion above can't see this (line-number math reads
	// `stripped`, never `originalLines`) — only the finding's `.text` can.
	it("P: the violation text is the full source line, not a single split(\"\") character", () => {
		const code =
			"class Poller {\n  start() { this.id = setInterval(() => this.tick(), 1000); }\n  stop() { this.running = false; }\n}";
		const out = checkLifecycleCleanup(code, "src/poller.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"setInterval() without matching clearInterval in lifecycle method: start() { this.id = setInterval(() => this.tick(), 1000); }",
		);
	});
});
