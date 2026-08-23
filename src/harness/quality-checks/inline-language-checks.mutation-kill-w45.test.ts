import { describe, expect, it } from "vitest";
import type { InlineCheckDef, LanguageProfile } from "../types.js";
import { runInlineLanguageChecks } from "./inline-language-checks.js";

// Wave pass1_w45 — targets 3 of 30 listed survivors in
// scratch/fleet-r3/w45-briefs/src_harness_quality-checks_inline-language-checks.ts.json.
// All three mutate NESTED_QUANTIFIER_RE (the ReDoS gate `looksLikeReDoS` reads
// to reject a config-supplied `def.pattern` before it's ever compiled). We
// exercise that gate only through the public API (`runInlineLanguageChecks`):
// craft a `def.pattern` regex-source string whose ReDoS-classification flips
// between the real regex and the mutant, and observe whether the check fires
// (pattern accepted + compiled) or is silently dropped (pattern rejected).
//
// The other 27 survivors in the brief were investigated and found to mutate
// either genuinely dead/unreachable branches (`!ctx` — buildContext never
// returns null) or state-machine "code" mode labels that are never read by
// `.kind === "code"` anywhere (only "line"/"string"/"block" are checked, so
// "code" is purely the implicit else-default) — no test can observe those
// mutations through this module's public surface, so they are reported as
// still_open rather than claimed.

function makeProfile(pattern: string): LanguageProfile {
	const def: InlineCheckDef = {
		name: "redos_probe",
		description: "probe pattern for ReDoS-gate mutation testing",
		file_types: [".probe"],
		severity: "warning",
		fix_instruction: "n/a",
		pattern,
	};
	return {
		id: "rust",
		display_name: "probe",
		file_extensions: [".probe"],
		project_root_markers: [],
		type_check: null,
		linter: null,
		test_runner: null,
		inline_checks: [def],
	};
}

describe("inline-language-checks — ReDoS-gate regex mutants (mutation-kill-w45)", () => {
	// c0f72991974cac27: [^)]*[+*][^)]* -> [^)]*[^+*][^)]*
	// "(abc)+" is NOT flagged as ReDoS by the real gate (no +/* inside the
	// group), so the check compiles and fires. The mutant's negated middle
	// class DOES match "(abc)+" (any non-+/* char, e.g. 'a', qualifies), so
	// the mutant rejects the pattern and the check silently disappears.
	// test-contract: public-api — runInlineLanguageChecks(file, content, profile)
	// is the module's sole exported entry point; result count/name is the only
	// observable of whether def.pattern was accepted or ReDoS-rejected.
	it("kills c0f72991974cac27 — (abc)+ must be accepted, not ReDoS-rejected", () => {
		const profile = makeProfile("(abc)+");
		const results = runInlineLanguageChecks("x.probe", "call site: (abc)+ here", profile);
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe("redos_probe");
	});

	// 78e1e90659a241dc: [^)]*[+*][^)]* -> [^)][+*][^)]*  (first * removed —
	// requires exactly one non-) char before the +/*).
	// "(\d+)+" (regex source `(\d+)+`) IS flagged ReDoS by the real gate
	// (zero-or-more "\" then "d" before the "+", one "+" for [+*], then the
	// trailing "+"). The mutant requires EXACTLY one non-) char immediately
	// before the middle +/*, which doesn't line up for this string, so the
	// mutant does NOT flag it — the pattern is accepted and the check fires.
	// test-contract: public-api — runInlineLanguageChecks is the only exported
	// surface; an empty result array is the observable signal that the ReDoS
	// gate rejected def.pattern before compilation.
	it("kills 78e1e90659a241dc — (\\d+)+ must be ReDoS-rejected (no result), not accepted", () => {
		const profile = makeProfile("(\\d+)+");
		const results = runInlineLanguageChecks("x.probe", "value 123 here", profile);
		expect(results).toHaveLength(0);
	});

	// 6d190cb806f2c43b: [^)]*[+*][^)]* -> [^)]*[+*][)]*  (second [^)]* changed
	// to [)]* — only zero-or-more literal ')' chars allowed there instead of
	// any non-) char).
	// "(a+bc)+" IS flagged ReDoS by the real gate (the "bc" after the "+"
	// satisfies [^)]*). The mutant requires only ')' characters in that slot,
	// which "bc" is not, so the mutant does NOT flag it and the check fires.
	// test-contract: public-api — runInlineLanguageChecks is the only exported
	// surface; an empty result array is the observable signal that the ReDoS
	// gate rejected def.pattern before compilation.
	it("kills 6d190cb806f2c43b — (a+bc)+ must be ReDoS-rejected (no result), not accepted", () => {
		const profile = makeProfile("(a+bc)+");
		const results = runInlineLanguageChecks("x.probe", "seen a+bc token", profile);
		expect(results).toHaveLength(0);
	});
});
