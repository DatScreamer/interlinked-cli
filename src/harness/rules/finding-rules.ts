// ===========================================
// Rules — Findings-distilled Rules (4th loader layer)
// ===========================================
// Loads rules distilled from corpus Findings by the `finding-distill` skill.
// A SEPARATE file from `/enforce`'s distilled-rules.json on purpose: a bare
// `/enforce` run fully regenerates its pristine file (keyed on source-file
// hashes), so co-tenanting finding rules there would silently delete them.
//
//   .interlinked/findings-rules.json           — pristine (skill-written)
//   .interlinked/findings-rules.overrides.json — user mods (survive re-distill)
//
// Same runtime layer / ReDoS gate / hot-reload as distilled-rules. The `source`
// sidecar (finding_id back-link, provenance) is metadata the harness IGNORES at
// evaluation — the CLI + recurrence use it. Fail-open on any parse error: rule
// loading must never block the daemon (feedback_safety_continuity).
//
// loadFindingRules returns only the ACTIVE set (drops disabled rules), so the
// rules-loader can spread it directly without re-filtering.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeReDoS } from "../redos-validation.js";
import type { GuardRule } from "../types.js";

/** Provenance sidecar emitted by the `finding-distill` skill. Ignored at eval. */
export interface FindingRuleSource {
	kind: "finding";
	bug_class: string;
	[key: string]: unknown;
	repo?: string;
	commit?: string;
	file?: string;
	lines?: [number, number];
	reviewer?: string;
	quote?: string;
}

export interface FindingRule extends GuardRule {
	source?: FindingRuleSource;
	distilled_action_reason?: string;
	confidence?: number;
	user_modified?: boolean;
}

interface FindingRulesFile {
	version?: number;
	rules?: FindingRule[];
}

interface RuleModification {
	action?: GuardRule["action"];
	severity?: GuardRule["severity"];
	note?: string;
}

interface FindingRulesOverrides {
	version?: number;
	removed_rule_ids?: string[];
	disabled_rule_ids?: string[];
	modifications?: Record<string, RuleModification>;
}

export function findingRulesPath(cwd: string): string {
	return join(cwd, ".interlinked", "findings-rules.json");
}

function findingRulesOverridesPath(cwd: string): string {
	return join(cwd, ".interlinked", "findings-rules.overrides.json");
}

function readJsonObject(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null; // malformed — treat as absent (fail-open)
	}
}

function normalizeFindingRuleSource(source: FindingRuleSource | undefined): FindingRuleSource | undefined {
	if (!source || source.kind !== "finding") return undefined;
	const normalized: FindingRuleSource = {
		kind: "finding",
		bug_class: source.bug_class,
	};
	copyStringSourceField(source, normalized, "finding_id");
	if (source.repo !== undefined) normalized.repo = source.repo;
	if (source.commit !== undefined) normalized.commit = source.commit;
	if (source.file !== undefined) normalized.file = source.file;
	if (source.lines !== undefined) normalized.lines = source.lines;
	if (source.reviewer !== undefined) normalized.reviewer = source.reviewer;
	copyStringSourceField(source, normalized, "found_at");
	if (source.quote !== undefined) normalized.quote = source.quote;
	return normalized;
}

function copyStringSourceField(
	source: FindingRuleSource,
	target: FindingRuleSource,
	key: string,
): void {
	const value = source[key];
	if (typeof value === "string") target[key] = value;
}

/**
 * Public API — consumed by `rules-loader.ts` via `loadRules()`. Reads the
 * pristine file, applies overrides, drops ReDoS-prone AND disabled rules, and
 * returns the active GuardRules. Mirrors `loadDistilledRules` minus the group
 * concept (findings have no source-file groups).
 */
export function loadFindingRules(cwd: string): GuardRule[] {
	const file = readJsonObject(findingRulesPath(cwd)) as FindingRulesFile | null;
	if (!file?.rules || !Array.isArray(file.rules)) return [];

	const overrides = (readJsonObject(findingRulesOverridesPath(cwd)) ?? {}) as FindingRulesOverrides;
	const removed = new Set(overrides.removed_rule_ids ?? []);
	const disabled = new Set(overrides.disabled_rule_ids ?? []);
	const mods = overrides.modifications ?? {};

	const out: GuardRule[] = [];
	for (const raw of file.rules) {
		if (!raw || typeof raw !== "object" || !raw.id) continue;
		if (removed.has(raw.id)) continue;

		// ReDoS gate — a finding rule's regex is LLM-authored from arbitrary
		// review prose; a nested-quantifier shape would hang the daemon. Same
		// guard as distilled rules. Skip the whole rule + one stderr line.
		const patterns = Array.isArray(raw.patterns) ? raw.patterns : [];
		const unsafe = patterns.find((p) => p && typeof p.regex === "string" && looksLikeReDoS(p.regex));
		if (unsafe) {
			process.stderr.write(
				`[interlinked] skipping finding rule ${raw.id}: ReDoS-prone pattern ${
					unsafe.regex?.slice(0, 120) ?? ""
				}\n`,
			);
			continue;
		}

		const rule: FindingRule = { ...raw };
		const source = normalizeFindingRuleSource(raw.source);
		delete rule.source;
		if (source) rule.source = source;
		const mod = mods[raw.id];
		if (mod) {
			if (mod.action !== undefined) rule.action = mod.action;
			if (mod.severity !== undefined) rule.severity = mod.severity;
			rule.user_modified = true;
		}
		rule.enabled = disabled.has(raw.id) ? false : raw.enabled !== false;
		if (rule.enabled) out.push(rule); // return only the active set
	}
	return out;
}

/** Public API — paths watched by `watchRulesFiles()` so changes hot-reload. */
export function getFindingRulesWatchPaths(cwd: string): string[] {
	return [findingRulesPath(cwd), findingRulesOverridesPath(cwd)];
}
