// ===========================================
// Statusline Snapshot Writer
// ===========================================
// Writes pre-computed state for the bash status-line script to read on
// each render. Two outputs:
//
//   .interlinked/statusline.snapshot   — key=value pairs (one per line)
//   .interlinked/loaded-rules.md       — effective merged ruleset, sorted
//
// The bash script (see writeStatuslineScript in src/lib/hook-installers.ts)
// does pure formatting; all the math lives here.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_RULES } from "./rules/builtin-rules.js";
import type { GuardRule, GuardRulesConfig } from "./types.js";

export interface StatuslineSnapshotInput {
	/** Project root — directory that owns `.interlinked/`. */
	cwd: string;
	/** Path to the `.interlinked/` directory. */
	interlinkedDir: string;
	/** Live merged guard-rules config from `loadRules()`. */
	rules: GuardRulesConfig;
	/** Count of currently held file reservations. */
	reservationsCount: number;
	/** Trigram index status: ready / stale / missing. */
	indexStatus: "ready" | "stale" | "missing";
	/** Indexed file count when the trigram index is loaded; 0 otherwise. */
	indexFiles: number;
	/** True when the server bridge is connected. */
	serverBridgeConnected: boolean;
}

interface PersistedConfigShape {
	mode?: unknown;
	active_server?: unknown;
	sync_mode?: unknown;
	workspace_id?: unknown;
	servers?: Record<string, { workspace_id?: unknown }>;
}

interface CheckPolicyShape {
	mode?: unknown;
}

/**
 * Write the statusline snapshot plus the two click-target markdown files
 * the bash script's OSC 8 hyperlinks point to:
 *
 *   .interlinked/statusline.snapshot   — key=value state for the script
 *   .interlinked/loaded-rules.md       — what the "N rules" segment links to
 *   .interlinked/loaded-checks.md      — what the "N checks" segment links to
 *
 * Best-effort: any I/O failure is swallowed. The bash script's fallback
 * path handles missing/stale snapshots.
 */
export function writeStatuslineArtifacts(input: StatuslineSnapshotInput): void {
	try {
		atomicWrite(join(input.interlinkedDir, "statusline.snapshot"), buildSnapshot(input));
	} catch (e) {
		void e;
	}
	try {
		atomicWrite(
			join(input.interlinkedDir, "loaded-rules.md"),
			buildLoadedRulesMarkdown(input.rules),
		);
	} catch (e) {
		void e;
	}
	try {
		atomicWrite(
			join(input.interlinkedDir, "loaded-checks.md"),
			buildLoadedChecksMarkdown(input.rules),
		);
	} catch (e) {
		void e;
	}
}

function buildSnapshot(input: StatuslineSnapshotInput): string {
	const modes = readModes(input.interlinkedDir);
	const counts = countRules(input.rules);
	const toggles = readToggles(input.rules);

	const checksEnabled = countEnabledQualityChecks(input.rules);

	const rows: string[] = [
		`harness_mode=${modes.harness}`,
		`enforcement_mode=${modes.enforcement}`,
		`sync_mode=${modes.sync}`,
		`active_server=${modes.activeServer}`,
		`workspace_id=${modes.workspaceId}`,
		`rules_total=${input.rules.rules.length}`,
		`rules_disabled=${counts.disabled}`,
		`rules_custom=${counts.custom}`,
		`checks_enabled=${checksEnabled}`,
		`reservations_count=${input.reservationsCount}`,
		`index_status=${input.indexStatus}`,
		`index_files=${input.indexFiles}`,
		`classifier_enabled=${toggles.classifier}`,
		`scanner_enabled=${toggles.scanner}`,
		`auto_coordination=${toggles.autoCoord}`,
		`server_bridge=${input.serverBridgeConnected ? "connected" : "local_only"}`,
		`generated_at=${new Date().toISOString()}`,
	];
	return `${rows.join("\n")}\n`;
}

function countEnabledQualityChecks(rules: GuardRulesConfig): number {
	let n = 0;
	for (const cfg of Object.values(rules.quality_checks)) {
		if (cfg?.enabled) n++;
	}
	if (rules.structural_checks?.enabled) n++;
	return n;
}

interface ResolvedModes {
	harness: string;
	enforcement: string;
	sync: string;
	activeServer: string;
	workspaceId: string;
}

function readModes(interlinkedDir: string): ResolvedModes {
	const shared = readJsonSafely<PersistedConfigShape>(join(interlinkedDir, "config.json"));
	const local = readJsonSafely<PersistedConfigShape>(join(interlinkedDir, "config.local.json"));
	const policy = readJsonSafely<CheckPolicyShape>(join(interlinkedDir, "check-policy.json"));

	const activeServer = nonEmptyString(local?.active_server) ?? "";
	const serverEntry = activeServer ? local?.servers?.[activeServer] : undefined;
	const workspaceId =
		nonEmptyString(serverEntry?.workspace_id) ?? nonEmptyString(local?.workspace_id) ?? "";

	return {
		harness: nonEmptyString(shared?.mode) ?? "quality",
		enforcement: nonEmptyString(policy?.mode) ?? "balanced",
		sync: nonEmptyString(local?.sync_mode) ?? "realtime",
		activeServer,
		workspaceId,
	};
}

interface RuleCounts {
	custom: number;
	disabled: number;
}

function countRules(rules: GuardRulesConfig): RuleCounts {
	const builtinIds = new Set(BUILTIN_RULES.map((r) => r.id));
	return {
		custom: rules.rules.filter((r) => !builtinIds.has(r.id)).length,
		disabled: (rules.disabled_rules ?? []).length,
	};
}

interface ToggleState {
	classifier: "enabled" | "disabled";
	scanner: "enabled" | "disabled";
	autoCoord: "on" | "off";
}

function readToggles(rules: GuardRulesConfig): ToggleState {
	return {
		classifier: rules.policy_classifier?.enabled ? "enabled" : "disabled",
		scanner: rules.content_scanner?.enabled ? "enabled" : "disabled",
		autoCoord: rules.auto_coordination?.enabled === false ? "off" : "on",
	};
}

function buildLoadedRulesMarkdown(rules: GuardRulesConfig): string {
	const builtinIds = new Set(BUILTIN_RULES.map((r) => r.id));
	const disabledIds = new Set(rules.disabled_rules ?? []);

	const active = [...rules.rules].sort(byCategoryThenId);

	const byCategory = new Map<string, GuardRule[]>();
	for (const r of active) {
		const cat = r.category || "uncategorized";
		const arr = byCategory.get(cat) ?? [];
		arr.push(r);
		byCategory.set(cat, arr);
	}

	const categories = [...byCategory.keys()].sort();

	const lines: string[] = [];
	lines.push("# Interlinked harness — loaded rules");
	lines.push("");
	lines.push(
		"_Auto-generated by the harness on rule load. Do not edit — see " +
			"`docs/generated/guard-rules.md` for the full reference, or edit " +
			"`.interlinked/guard-rules.json` / `.interlinked/guard-rules.local.json` " +
			"to change what's loaded here._",
	);
	lines.push("");
	lines.push(`Total active rules: **${active.length}**`);
	lines.push("");

	for (const cat of categories) {
		const entries = byCategory.get(cat);
		if (!entries) continue;
		lines.push(`## ${humanizeCategory(cat)} (${entries.length})`);
		lines.push("");
		for (const r of entries) {
			const source = builtinIds.has(r.id) ? "built-in" : "custom";
			lines.push(`- \`${r.id}\` — ${r.action} — ${r.severity} — ${source} — ${r.reason}`);
		}
		lines.push("");
	}

	if (disabledIds.size > 0) {
		lines.push(`## Disabled rules (${disabledIds.size})`);
		lines.push("");
		for (const id of [...disabledIds].sort()) {
			lines.push(`- ~~\`${id}\`~~ — disabled in \`guard-rules.local.json\``);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function buildLoadedChecksMarkdown(rules: GuardRulesConfig): string {
	const entries = Object.entries(rules.quality_checks)
		.map(([name, cfg]) => ({ name, cfg }))
		.sort((a, b) => {
			if (a.name < b.name) return -1;
			if (a.name > b.name) return 1;
			return 0;
		});

	const enabled = entries.filter((e) => e.cfg?.enabled);
	const disabled = entries.filter((e) => !e.cfg?.enabled);

	const lines: string[] = [];
	lines.push("# Interlinked harness — loaded checks");
	lines.push("");
	lines.push(
		"_Auto-generated by the harness on rule load. Do not edit — see " +
			"`.interlinked/check-policy.json` for the active mode (balanced/strict/lenient) " +
			"or `.interlinked/guard-rules.local.json` to flip individual checks on/off._",
	);
	lines.push("");
	let activeCount = enabled.length;
	if (rules.structural_checks?.enabled) activeCount++;
	lines.push(`Active checks: **${activeCount}**`);
	lines.push("");

	if (rules.structural_checks?.enabled) {
		lines.push("## Structural checks");
		lines.push("");
		lines.push(
			"- `structural_checks` — error — built-in — Cross-file dependency checks: " +
				"export surface, import resolution, dependency cycles, blast radius.",
		);
		lines.push("");
	}

	if (enabled.length > 0) {
		lines.push(`## Quality checks — enabled (${enabled.length})`);
		lines.push("");
		for (const { name, cfg } of enabled) {
			const desc = cfg.description || `Runs on edits to ${cfg.file_types.join(", ") || "all files"}.`;
			const cmd = cfg.command ? ` — \`${cfg.command}\`` : "";
			lines.push(`- \`${name}\` — ${cfg.severity}${cmd} — ${desc}`);
		}
		lines.push("");
	}

	if (disabled.length > 0) {
		lines.push(`## Quality checks — disabled (${disabled.length})`);
		lines.push("");
		lines.push(
			"_Re-enable in `.interlinked/guard-rules.local.json` under " +
				"`quality_checks.<name>.enabled = true`._",
		);
		lines.push("");
		for (const { name, cfg } of disabled) {
			const desc = cfg?.description || "";
			lines.push(`- ~~\`${name}\`~~ — ${cfg?.severity || ""} ${desc ? "— " + desc : ""}`.trim());
		}
		lines.push("");
	}

	return lines.join("\n");
}


function byCategoryThenId(a: GuardRule, b: GuardRule): number {
	const ca = a.category || "uncategorized";
	const cb = b.category || "uncategorized";
	if (ca !== cb) return ca < cb ? -1 : 1;
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return 0;
}

function humanizeCategory(cat: string): string {
	return cat
		.split(/[_-]/)
		.map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
		.join(" ");
}

function readJsonSafely<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

function nonEmptyString(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	if (v === "") return undefined;
	return v;
}

function atomicWrite(path: string, content: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}
