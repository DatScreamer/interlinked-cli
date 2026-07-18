import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessDecision, SessionTrajectory } from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";
import { prerefreshSpecLedger, runSpecLedgerPhase } from "./spec-ledger-phase.js";

const PLAN = [
	"# Plan",
	"## The seven bets",
	"| **B1** | a |",
	"| **B2** | b |",
	"| **B3** | c |",
	"| **B4** | d |",
	"| **B5** | e |",
	"| **B6** | f |",
	"| **B7** | g |",
].join("\n");

const README = "# README\nThe composition of six bets does the work.\n";

function makeFixture(): {
	root: string;
	ctx: ServerRuntime;
	session: SessionTrajectory;
	decision: HarnessDecision;
	acc: PerFileCheckCtx;
} {
	const root = mkdtempSync(join(tmpdir(), "spec-phase-"));
	writeFileSync(join(root, "PLAN.md"), PLAN);
	writeFileSync(join(root, "README.md"), README);
	// SAFETY: the phase reads only cwd/rules/log/specLedger from the runtime
	// and pending_completions/tool_call_count/spec_drift_outstanding from the
	// session — a minimal fixture keeps this test independent of the full
	// server bootstrap (same pattern as post-tool-file-checks-phases.test.ts).
	const ctx = {
		cwd: root,
		rules: { spec_checks: { enabled: true } },
		log: () => {},
		specLedger: null,
	} as unknown as ServerRuntime;
	const session = {
		pending_completions: new Map(),
		tool_call_count: 3,
	} as unknown as SessionTrajectory;
	const decision: HarnessDecision = { decision: "allow" };
	// SAFETY: the phase touches only allCheckResults/checksRan on the
	// accumulator; the remaining PerFileCheckCtx fields are unused here.
	const acc = {
		allCheckResults: [],
		checksRan: [],
	} as unknown as PerFileCheckCtx;
	return { root, ctx, session, decision, acc };
}

describe("runSpecLedgerPhase", () => {
	const fixtures: string[] = [];
	afterAll(() => {
		for (const root of fixtures) rmSync(root, { recursive: true, force: true });
	});

	it("resolves in-root symlink aliases to the walked ledger key (round-2 #13)", async () => {
		const { mkdirSync: mkdir, symlinkSync } = await import("node:fs");
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		mkdir(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "a.md"), "# A\n| X-01 | a |\n| X-02 | b |");
		symlinkSync(join(root, "docs"), join(root, "alias"), "dir");
		// Refresh through the real path AND the alias: canonicalization must
		// yield ONE ledger key (docs/a.md), not a duplicate alias/a.md (#13).
		prerefreshSpecLedger(ctx, [
			join(root, "docs", "a.md"),
			join(root, "alias", "a.md"),
		]);
		const ledger = ctx.specLedger as { fileList(): string[] } | null | undefined;
		const keys = ledger?.fileList() ?? [];
		// The alias resolved to the real path: docs/a.md present exactly once,
		// no duplicate alias/a.md key.
		expect(keys).toContain("docs/a.md");
		expect(keys.filter((k) => k.endsWith("a.md"))).toEqual(["docs/a.md"]);
		// Also exercises the canonicalPath fallback branch: a not-on-disk path
		// → realpath throws → lexical key. The phase must not throw.
		expect(() =>
			runSpecLedgerPhase(ctx, join(root, "gone.md"), true, session, decision, acc),
		).not.toThrow();
	});

	it("prerefreshSpecLedger evaluates a multi-file patch against final state (deep-round #3)", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		// One patch fixes BOTH sides: plan gains a 7th bet, README updates
		// six→seven. Evaluated against final state, there is no drift — without
		// the pre-pass, processing README first would compare it to the stale
		// 6-bet plan and warn spuriously.
		writeFileSync(
			join(root, "PLAN.md"),
			"## The seven bets\n| B1 | a |\n| B2 | b |\n| B3 | c |\n| B4 | d |\n| B5 | e |\n| B6 | f |\n| B7 | g |",
		);
		writeFileSync(join(root, "README.md"), "# README\nThe composition of seven bets.\n");
		prerefreshSpecLedger(ctx, [join(root, "PLAN.md"), join(root, "README.md")]);
		runSpecLedgerPhase(ctx, join(root, "README.md"), true, session, decision, acc);
		expect(decision.warnings ?? []).toEqual([]);
	});

	it("editing the registry file surfaces sibling drift and records obligations", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		runSpecLedgerPhase(ctx, join(root, "PLAN.md"), true, session, decision, acc);
		expect(decision.warnings?.some((w) => w.includes("six bets"))).toBe(true);
		expect(decision.warnings?.[0]).toContain("[interlinked:spec-drift]");
		expect(acc.checksRan).toContain("spec_ledger");
		expect(acc.allCheckResults[0]).toEqual(
			expect.objectContaining({ source: "spec", severity: "warning" }),
		);
		// The finding is anchored in README.md — a sibling obligation.
		const keys = [...session.pending_completions.keys()];
		expect(keys.some((k) => k.startsWith("spec:count_claim_drift:README.md"))).toBe(
			true,
		);
		expect(session.spec_drift_outstanding?.length).toBeGreaterThan(0);
	});

	it("does nothing for non-markdown edits, disabled config, or out-of-repo files", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		runSpecLedgerPhase(ctx, join(root, "code.ts"), true, session, decision, acc);
		expect(decision.warnings).toBeUndefined();

		const disabled = makeFixture();
		fixtures.push(disabled.root);
		// SAFETY: minimal fixture — see above.
		(disabled.ctx as { rules: { spec_checks: { enabled: boolean } } }).rules =
			{ spec_checks: { enabled: false } };
		runSpecLedgerPhase(
			disabled.ctx,
			join(disabled.root, "PLAN.md"),
			true,
			disabled.session,
			disabled.decision,
			disabled.acc,
		);
		expect(disabled.decision.warnings).toBeUndefined();

		const outOfRepo = makeFixture();
		fixtures.push(outOfRepo.root);
		runSpecLedgerPhase(
			outOfRepo.ctx,
			join(outOfRepo.root, "PLAN.md"),
			false,
			outOfRepo.session,
			outOfRepo.decision,
			outOfRepo.acc,
		);
		expect(outOfRepo.decision.warnings).toBeUndefined();
	});

	it("an unrelated markdown edit never erases the outstanding stash (round-4 #1)", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		runSpecLedgerPhase(ctx, join(root, "PLAN.md"), true, session, decision, acc);
		expect(session.spec_drift_outstanding?.length).toBeGreaterThan(0);
		// Now edit an unrelated markdown file with no findings of its own.
		writeFileSync(join(root, "NOTES.md"), "# Notes\nplain text\n");
		const decision2: HarnessDecision = { decision: "allow" };
		runSpecLedgerPhase(ctx, join(root, "NOTES.md"), true, session, decision2, acc);
		expect(decision2.warnings).toBeUndefined();
		expect(
			session.spec_drift_outstanding?.some((f) => f.file === "README.md"),
		).toBe(true);
	});

	it("clears the stash when the drift is resolved and never throws on fs errors", () => {
		const { root, ctx, session, decision, acc } = makeFixture();
		fixtures.push(root);
		writeFileSync(join(root, "README.md"), "# README\nSeven bets now.\n");
		runSpecLedgerPhase(ctx, join(root, "README.md"), true, session, decision, acc);
		expect(session.spec_drift_outstanding).toEqual([]);
		expect(decision.warnings).toBeUndefined();
		// Deleted file mid-flight: the phase logs and moves on.
		runSpecLedgerPhase(
			ctx,
			join(root, "GONE.md"),
			true,
			session,
			decision,
			acc,
		);
		expect(decision.warnings).toBeUndefined();
	});
});
