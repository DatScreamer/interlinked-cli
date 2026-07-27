import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import {
	detectBaselineGaming,
	evaluateBaselineIntegrityForEvent,
} from "./baseline-integrity-gate.js";

const alwaysExists = () => true;
const neverExists = () => false;
const COV = "/repo/.interlinked/coverage-baseline.json";
const COV_EDIT = "/repo/.interlinked/coverage-edit-baseline.json";
const MUT = "/repo/.interlinked/mutation-baseline.json";
const LARGE = "/repo/.interlinked/large-files-baseline.json";
const UNTESTED = "/repo/.interlinked/untested-files-baseline.json";
const CAPS = "/repo/.interlinked/metric-caps.json";
const SKIPPED = "/repo/.interlinked/skipped-tests-baseline.json";
const EVIDENCE = "/repo/.interlinked/check-evidence-baseline.json";

function detect(file: string, before: unknown, after: unknown, exists = alwaysExists) {
	return detectBaselineGaming(file, JSON.stringify(before), JSON.stringify(after), exists);
}

describe("detectBaselineGaming — not a baseline file / no HEAD", () => {
	it("ignores non-baseline files", () => {
		expect(detectBaselineGaming("/repo/src/foo.ts", "a", "b")).toEqual([]);
		expect(detectBaselineGaming("/repo/.interlinked/other.json", "{}", "{}")).toEqual([]);
	});
	it("returns [] for a brand-new baseline (no before text)", () => {
		expect(detectBaselineGaming(COV, "", '{"files":{}}')).toEqual([]);
	});
	it("fails open on unparseable JSON", () => {
		expect(detectBaselineGaming(COV, "{not json", '{"files":{}}')).toEqual([]);
		expect(detectBaselineGaming(COV, '{"files":{}}', "{not json")).toEqual([]);
	});
});

describe("coverage-baseline.json — values may only rise", () => {
	const base = { version: 1, files: { "src/a.ts": { lines_pct: 90, branches_pct: 80 } } };
	it("BLOCKS a lowered lines_pct", () => {
		const f = detect(COV, base, { files: { "src/a.ts": { lines_pct: 50, branches_pct: 80 } } });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toContain("lines_pct");
	});
	it("BLOCKS a lowered branches_pct", () => {
		const f = detect(COV, base, { files: { "src/a.ts": { lines_pct: 90, branches_pct: 10 } } });
		expect(f).toHaveLength(1);
		expect(f[0]?.rule).toContain("branches_pct");
	});
	it("BLOCKS removing an entry whose source still exists", () => {
		const f = detect(COV, base, { files: {} }, alwaysExists);
		expect(f).toHaveLength(1);
	});
	it("ALLOWS removing an entry whose source was deleted", () => {
		expect(detect(COV, base, { files: {} }, neverExists)).toEqual([]);
	});
	it("ALLOWS raising a pct and adding a new file", () => {
		const after = {
			files: { "src/a.ts": { lines_pct: 95, branches_pct: 85 }, "src/b.ts": { lines_pct: 1, branches_pct: 1 } },
		};
		expect(detect(COV, base, after)).toEqual([]);
	});
});

describe("coverage-edit-baseline.json — flat map, values may only rise", () => {
	it("BLOCKS a lowered value", () => {
		expect(detect(COV_EDIT, { "src/a.ts": 0.9 }, { "src/a.ts": 0.4 })).toHaveLength(1);
	});
	it("ALLOWS a raised value and a new entry", () => {
		expect(detect(COV_EDIT, { "src/a.ts": 0.9 }, { "src/a.ts": 0.95, "src/b.ts": 0.1 })).toEqual([]);
	});
	it("BLOCKS removing an entry whose source still exists", () => {
		expect(detect(COV_EDIT, { "src/a.ts": 0.9 }, {}, alwaysExists)).toHaveLength(1);
	});

	// Scoped-object shape ({f, scope}) — the per-edit gate stores which test set
	// measured a fraction so it re-anchors across scopes instead of false-blocking.
	it("BLOCKS a same-scope fraction lowering in the object shape", () => {
		const before = { "src/a.ts": { f: 0.9, scope: "scoped:aaa" } };
		const after = { "src/a.ts": { f: 0.4, scope: "scoped:aaa" } };
		expect(detect(COV_EDIT, before, after)).toHaveLength(1);
	});
	it("ALLOWS a lower fraction under a DIFFERENT scope (legitimate re-anchor)", () => {
		const before = { "src/a.ts": { f: 1, scope: "scoped:broad" } };
		const after = { "src/a.ts": { f: 0.66, scope: "scoped:narrow" } };
		expect(detect(COV_EDIT, before, after)).toEqual([]);
	});
	it("ALLOWS re-anchoring a legacy bare-number entry into the scoped shape", () => {
		expect(detect(COV_EDIT, { "src/a.ts": 1 }, { "src/a.ts": { f: 0.66, scope: "scoped:x" } })).toEqual([]);
	});
	it("BLOCKS a same-scope lowering across the legacy/object boundary (null scope both sides)", () => {
		// A bare number decodes to scope null; an object with no scope also null →
		// same scope → a fraction drop is still gaming.
		expect(detect(COV_EDIT, { "src/a.ts": 0.9 }, { "src/a.ts": { f: 0.4 } })).toHaveLength(1);
	});
});

describe("mutation-baseline.json — score/killed may only rise", () => {
	const base = { version: 1, files: { "src/a.ts": { score: 0.8, killed: 10 } } };
	it("BLOCKS a lowered score", () => {
		expect(detect(MUT, base, { files: { "src/a.ts": { score: 0.5, killed: 10 } } })).toHaveLength(1);
	});
	it("BLOCKS a lowered killed count", () => {
		expect(detect(MUT, base, { files: { "src/a.ts": { score: 0.8, killed: 3 } } })).toHaveLength(1);
	});
	it("ALLOWS a raised score", () => {
		expect(detect(MUT, base, { files: { "src/a.ts": { score: 0.9, killed: 12 } } })).toEqual([]);
	});
});

describe("large-files-baseline.json — cap tightens, grandfather counts shrink", () => {
	const base = { version: 1, max_lines: 500, files: { "src/big.ts": 620 } };
	it("BLOCKS raising max_lines", () => {
		expect(detect(LARGE, base, { max_lines: 800, files: { "src/big.ts": 620 } })).toHaveLength(1);
	});
	it("BLOCKS raising a grandfather high-water count", () => {
		expect(detect(LARGE, base, { max_lines: 500, files: { "src/big.ts": 700 } })).toHaveLength(1);
	});
	it("BLOCKS a new grandfather entry over the cap", () => {
		const after = { max_lines: 500, files: { "src/big.ts": 620, "src/new.ts": 550 } };
		expect(detect(LARGE, base, after)).toHaveLength(1);
	});
	it("ALLOWS lowering the cap, shrinking a count, resolving (removing) an entry, new under-cap entry", () => {
		expect(detect(LARGE, base, { max_lines: 400, files: { "src/big.ts": 600 } })).toEqual([]);
		expect(detect(LARGE, base, { max_lines: 500, files: {} })).toEqual([]);
		expect(detect(LARGE, base, { max_lines: 500, files: { "src/big.ts": 620, "ok.ts": 100 } })).toEqual([]);
	});
});

describe("untested-files-baseline.json — INVERTED: exemption list may only shrink", () => {
	const base = { version: 1, min_coverage_pct: 60, files: ["src/a.ts"] };
	it("BLOCKS lowering min_coverage_pct", () => {
		expect(detect(UNTESTED, base, { min_coverage_pct: 30, files: ["src/a.ts"] })).toHaveLength(1);
	});
	it("BLOCKS adding a path to the exemption list", () => {
		expect(detect(UNTESTED, base, { min_coverage_pct: 60, files: ["src/a.ts", "src/b.ts"] })).toHaveLength(1);
	});
	it("ALLOWS raising the floor and removing an exemption", () => {
		expect(detect(UNTESTED, base, { min_coverage_pct: 80, files: [] })).toEqual([]);
	});
});

describe("check-evidence-baseline.json — INVERTED: exemption list may only shrink", () => {
	const base = { exempt: ["self_import", "eval_usage"] };

	it("P1: BLOCKS adding a check id to the exemption list", () => {
		const after = { exempt: ["self_import", "eval_usage", "brand_new_check"] };
		const found = detect(EVIDENCE, base, after);
		expect(found).toHaveLength(1);
		expect(found[0]?.message).toMatch(/brand_new_check/);
	});

	it("P2: BLOCKS each added id separately so the report names all of them", () => {
		const after = { exempt: ["self_import", "eval_usage", "a_check", "b_check"] };
		expect(detect(EVIDENCE, base, after)).toHaveLength(2);
	});

	it("P3: BLOCKS an add even when another entry is simultaneously removed", () => {
		// Swapping one exemption for another keeps the count flat but still
		// exempts a check that was previously gated.
		const after = { exempt: ["self_import", "sneaky_check"] };
		expect(detect(EVIDENCE, base, after)).toHaveLength(1);
	});

	it("N1: ALLOWS removing an exemption (the ratchet direction)", () => {
		expect(detect(EVIDENCE, base, { exempt: ["self_import"] })).toEqual([]);
	});

	it("N2: ALLOWS emptying the list entirely", () => {
		expect(detect(EVIDENCE, base, { exempt: [] })).toEqual([]);
	});

	it("N3: ALLOWS an unchanged list", () => {
		expect(detect(EVIDENCE, base, base)).toEqual([]);
	});

	it("N4: ALLOWS a note-only edit", () => {
		expect(detect(EVIDENCE, base, { ...base, note: "clarified the policy" })).toEqual([]);
	});

	it("N5: ignores a malformed exempt field rather than blocking blindly", () => {
		expect(detect(EVIDENCE, base, { exempt: "not-an-array" })).toEqual([]);
	});

	describe("enforced dimensions — GROW-ONLY", () => {
		const staged = { exempt: [], enforced: ["cases", "corpus"] };

		it("P1: BLOCKS dropping an enforced dimension", () => {
			const found = detect(EVIDENCE, staged, { exempt: [], enforced: ["cases"] });
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toMatch(/corpus/);
		});

		it("P2: BLOCKS clearing the list entirely, once per dropped dimension", () => {
			expect(detect(EVIDENCE, staged, { exempt: [], enforced: [] })).toHaveLength(2);
		});

		it("P3: BLOCKS removing the field altogether", () => {
			expect(detect(EVIDENCE, staged, { exempt: [] })).toHaveLength(2);
		});

		it("N1: ALLOWS widening enforcement", () => {
			expect(detect(EVIDENCE, staged, { exempt: [], enforced: ["cases", "corpus", "mutation"] })).toEqual([]);
		});

		it("N2: ALLOWS an unchanged list", () => {
			expect(detect(EVIDENCE, staged, staged)).toEqual([]);
		});

		it("N3: ALLOWS reordering", () => {
			expect(detect(EVIDENCE, staged, { exempt: [], enforced: ["corpus", "cases"] })).toEqual([]);
		});

		it("reports an enforced shrink and an exemption add together", () => {
			const after = { exempt: ["new_check"], enforced: ["cases"] };
			expect(detect(EVIDENCE, staged, after)).toHaveLength(2);
		});
	});
});

describe("skipped-tests-baseline.json — skip cap tightens, grandfather counts shrink", () => {
	const base = { version: 1, max_skipped: 0, files: { "src/legacy.test.ts": 3 } };
	it("BLOCKS raising max_skipped", () => {
		expect(detect(SKIPPED, base, { max_skipped: 2, files: { "src/legacy.test.ts": 3 } })).toHaveLength(1);
	});
	it("BLOCKS raising a grandfather skip ceiling", () => {
		expect(detect(SKIPPED, base, { max_skipped: 0, files: { "src/legacy.test.ts": 5 } })).toHaveLength(1);
	});
	it("BLOCKS a new grandfather entry above the cap", () => {
		const after = { max_skipped: 0, files: { "src/legacy.test.ts": 3, "src/new.test.ts": 1 } };
		expect(detect(SKIPPED, base, after)).toHaveLength(1);
	});
	it("ALLOWS shrinking a ceiling, resolving an entry, and holding steady", () => {
		expect(detect(SKIPPED, base, { max_skipped: 0, files: { "src/legacy.test.ts": 1 } })).toEqual([]);
		expect(detect(SKIPPED, base, { max_skipped: 0, files: {} })).toEqual([]);
		expect(detect(SKIPPED, base, base)).toEqual([]);
	});
});

describe("metric-caps.json — caps may only tighten", () => {
	const base = { max_lines: 500, max_cyclomatic: 25, crap_threshold: 30, min_coverage: 60 };
	it("BLOCKS raising max_cyclomatic", () => {
		expect(detect(CAPS, base, { ...base, max_cyclomatic: 40 })).toHaveLength(1);
	});
	it("BLOCKS raising crap_threshold and max_lines", () => {
		expect(detect(CAPS, base, { ...base, crap_threshold: 50, max_lines: 900 })).toHaveLength(2);
	});
	it("BLOCKS lowering min_coverage", () => {
		expect(detect(CAPS, base, { ...base, min_coverage: 0 })).toHaveLength(1);
	});
	it("ALLOWS tightening every cap", () => {
		expect(detect(CAPS, base, { max_lines: 400, max_cyclomatic: 20, crap_threshold: 25, min_coverage: 80 })).toEqual([]);
	});
});

describe("default sourceExists (real fs)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	it("blocks removal of an entry whose real source file exists", () => {
		const root = mkdtempSync(join(tmpdir(), "bi-"));
		dirs.push(root);
		writeFileSync(join(root, "real.ts"), "export const x = 1;");
		const file = join(root, ".interlinked", "coverage-baseline.json");
		const before = JSON.stringify({ files: { "real.ts": { lines_pct: 90 } } });
		// no injected predicate → uses makeDefaultSourceExists rooted at `root`
		expect(detectBaselineGaming(file, before, JSON.stringify({ files: {} }))).toHaveLength(1);
		// a phantom source → removal allowed
		const before2 = JSON.stringify({ files: { "ghost.ts": { lines_pct: 90 } } });
		expect(detectBaselineGaming(file, before2, JSON.stringify({ files: {} }))).toEqual([]);
	});
});

function mkEvent(toolInput: Record<string, unknown>, cwd?: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "t",
		tool_name: "Write",
		tool_input: toolInput,
		cwd,
	} as unknown as HarnessEvent;
}

describe("evaluateBaselineIntegrityForEvent", () => {
	const lower = JSON.stringify({ files: { "src/a.ts": { lines_pct: 10 } } });
	const head = JSON.stringify({ files: { "src/a.ts": { lines_pct: 90 } } });
	const deps = { getDisk: () => head };

	it("returns null for a non-baseline file", () => {
		expect(evaluateBaselineIntegrityForEvent(mkEvent({ file_path: "/repo/src/a.ts", content: lower }), deps)).toBeNull();
	});
	it("respects the INTERLINKED_DISABLE_BASELINE_GUARD bypass", () => {
		const prev = process.env.INTERLINKED_DISABLE_BASELINE_GUARD;
		process.env.INTERLINKED_DISABLE_BASELINE_GUARD = "1";
		try {
			expect(evaluateBaselineIntegrityForEvent(mkEvent({ file_path: COV, content: lower }), deps)).toBeNull();
		} finally {
			if (prev === undefined) delete process.env.INTERLINKED_DISABLE_BASELINE_GUARD;
			else process.env.INTERLINKED_DISABLE_BASELINE_GUARD = prev;
		}
	});
	it("BLOCKS a Write that lowers a baseline", () => {
		const d = evaluateBaselineIntegrityForEvent(mkEvent({ file_path: COV, content: lower }), deps);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("baseline_integrity_gate");
	});
	it("BLOCKS an Edit (old_string/new_string) that lowers a baseline", () => {
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: COV, old_string: '"lines_pct":90', new_string: '"lines_pct":10' }),
			{ getDisk: () => head },
		);
		expect(d?.decision).toBe("block");
	});
	it("BLOCKS a MultiEdit that lowers a baseline", () => {
		const d = evaluateBaselineIntegrityForEvent(
			mkEvent({ file_path: COV, edits: [{ old_string: '"lines_pct":90', new_string: '"lines_pct":10' }] }),
			{ getDisk: () => head },
		);
		expect(d?.decision).toBe("block");
	});
	it("ALLOWS a Write that raises a baseline", () => {
		const raise = JSON.stringify({ files: { "src/a.ts": { lines_pct: 99 } } });
		expect(evaluateBaselineIntegrityForEvent(mkEvent({ file_path: COV, content: raise }), deps)).toBeNull();
	});
	it("fails open when the baseline does not exist yet", () => {
		expect(evaluateBaselineIntegrityForEvent(mkEvent({ file_path: COV, content: lower }), { getDisk: () => null })).toBeNull();
	});
	it("fails open when an Edit cannot be reconstructed", () => {
		expect(
			evaluateBaselineIntegrityForEvent(
				mkEvent({ file_path: COV, old_string: "absent", new_string: "x" }),
				{ getDisk: () => head },
			),
		).toBeNull();
	});
});

describe("mutation-manifest accepted-survivor set may only shrink (spec §7)", () => {
	const MUT_MANIFEST = "/repo/.interlinked/mutation-manifest.json";
	const mm = (status: string) => ({ version: 1, files: { "a.ts": { sym1: { mutants: { m1: { status } } } } } });

	it("blocks hand-adding a survived/equivalent entry to silence the gate", () => {
		const findings = detect(MUT_MANIFEST, mm("killed"), mm("survived"));
		expect(findings.some((f) => f.rule.includes("accepted-survivor-added"))).toBe(true);
	});

	it("allows shrinking the accepted set (survived → killed)", () => {
		expect(detect(MUT_MANIFEST, mm("survived"), mm("killed"))).toEqual([]);
	});

	it("allows an unchanged manifest", () => {
		expect(detect(MUT_MANIFEST, mm("survived"), mm("survived"))).toEqual([]);
	});
});
