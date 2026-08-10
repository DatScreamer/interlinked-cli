// ===========================================
// Flake-rate calibrator — the e-process's first live consumer (DW P4 §6)
// ===========================================
// Feeds each P0.2 flake double-run outcome (diverged / clean) into a persistent
// anytime-valid e-process. The single [interlinked:flake] warning fires on ANY
// divergence (a one-off flake); THIS layer adds a calibrated escalation that
// fires only when the flake RATE is statistically elevated — turning "one flaky
// run, ignore it" vs "this suite is genuinely nondeterministic" into a valid
// distinction instead of a fixed cutoff. That is the anti-derailment point:
// don't nudge on noise, do nudge on a real problem.
//
// State is persisted per-repo (flakiness is a repo property, not a session one)
// and best-effort — any fs error just means this run doesn't escalate. Re-arms
// after an alarm and rolls the window at a cap so a long-healthy suite stays
// responsive to a NEW regression rather than sitting on deep negative evidence.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import {
	createEProcess,
	type EProcessConfig,
	type EProcessState,
	isAnomalous,
	observe,
	summarize,
} from "./eprocess.js";

/** Tolerated 5% flake rate as the null; bet against a 30% (genuinely flaky)
 *  suite; conservative α so a real suite must accumulate before we escalate. */
const FLAKE_CFG: EProcessConfig = { p0: 0.05, p1: 0.3, alpha: 0.01 };
/** Rolling-window cap: reset once a long clean run has accumulated this many
 *  observations, so a later regression isn't buried under old negatives. */
const RESET_N = 200;

function statePath(cwd: string): string {
	return join(cwd, ".interlinked", "flake-eprocess.json");
}

function load(cwd: string): EProcessState {
	try {
		const p = statePath(cwd);
		if (!existsSync(p)) return createEProcess();
		const raw: unknown = JSON.parse(readFileSync(p, "utf-8"));
		if (
			isJsonObject(raw) &&
			typeof raw.logE === "number" &&
			typeof raw.n === "number" &&
			typeof raw.positives === "number"
		) {
			return { logE: raw.logE, n: raw.n, positives: raw.positives };
		}
		return createEProcess();
	} catch (err) {
		void err;
		return createEProcess();
	}
}

function save(cwd: string, state: EProcessState): void {
	try {
		const p = statePath(cwd);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(state));
	} catch (err) {
		void err; // best-effort — a missed persist just delays escalation
	}
}

/**
 * Fold one flake outcome (`diverged`) into the persistent e-process and return a
 * calibrated escalation string when the flake rate is validly anomalous, else
 * null. Re-arms after alarming; rolls the window at the cap. Never throws.
 */
export function observeFlakeOutcome(cwd: string, diverged: boolean): string | null {
	const next = observe(load(cwd), diverged, FLAKE_CFG);
	if (isAnomalous(next, FLAKE_CFG)) {
		const s = summarize(next, FLAKE_CFG);
		save(cwd, createEProcess()); // re-arm for the next regime
		return (
			`flakiness is statistically elevated: ${Math.round(s.empiricalRate * 100)}% of ${s.n} ` +
			`recent flake-checks diverged (e-value ${Math.round(s.eValue)} ≥ ${s.threshold}). This is not ` +
			"a one-off — the suite has a real nondeterminism problem worth fixing before it derails runs."
		);
	}
	save(cwd, next.n >= RESET_N ? createEProcess() : next);
	return null;
}
