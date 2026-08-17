// ===========================================
// `interlinked caps` — view, set, and explain the quality-metric caps
// ===========================================
// One surface for the four caps the harness enforces (lines / cyclomatic / CRAP
// / coverage). We ship conservative defaults; every user tunes their own caps
// here, written to the committed `.interlinked/metric-caps.json`. All metric
// definitions come from the single-sourced METRIC_DEFS glossary in
// `metric-caps.ts`, so the command, the block messages, and the generated docs
// describe each metric identically — no agent is ever confused about what a
// metric is or how to change it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLargeFileBaseline } from "../harness/large-file-policy.js";
import {
	COVERAGE_SCALE_MAX,
	METRIC_DEFS,
	resetMetricCapsCache,
	resolveMetricCaps,
} from "../harness/metric-caps.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

interface CapRow {
	key: string;
	label: string;
	value: number;
	unit: string;
	source: string;
	defaultValue: number;
	stricter: string;
}

/** Resolve every metric's effective cap + provenance, the same way the gates do
 *  (metric-caps.json override → legacy source → shipped default). */
function buildRows(cwd: string): CapRow[] {
	const baseline = loadLargeFileBaseline(cwd)?.max_lines;
	const resolved = resolveMetricCaps(cwd, baseline !== undefined ? { max_lines: baseline } : {});
	return METRIC_DEFS.map((d) => {
		const r = resolved[d.configKey];
		return {
			key: d.key,
			label: d.label,
			value: r.value,
			unit: d.unit,
			source: r.source,
			defaultValue: d.defaultValue,
			stricter: d.stricter,
		};
	});
}

/**
 * Render one `caps` row. Coverage is a GOAL, not a cap (nothing above it is
 * penalized, and it cannot exceed the scale's own 100): the number states
 * where the hold-or-rise ratchet is heading, while `interlinked adopt` seeds
 * today's per-file % as the floor. Same semantics as `formatMetricDefaultRow`
 * in harness/metric-caps.ts (operator reports 2026-08-16/17).
 */
function formatCapShowRow(r: CapRow): string {
	if (r.stricter === "higher") {
		return (
			`${r.key.padEnd(11)} goal ${String(r.value).padStart(3)} %` +
			`     — ratchets rise toward it from your adopted floor [${r.source}; default ${r.defaultValue}]`
		);
	}
	const unit = r.unit ? ` ${r.unit}` : "";
	return (
		`${r.key.padEnd(11)} ≤ ${String(r.value).padStart(3)}${unit.padEnd(9)} ` +
		`[${r.source}; ${r.stricter}-is-stricter; default ${r.defaultValue}]`
	);
}

/** `interlinked caps` — show the four effective caps + where each came from. */
export async function capsShowAction(
	opts: { json?: boolean },
	deps: { cwd?: string } = {},
): Promise<number> {
	const cwd = deps.cwd ?? process.cwd();
	const rows = buildRows(cwd);
	if (opts.json) {
		const obj: Record<string, { value: number; source: string; default: number }> = {};
		for (const r of rows) obj[r.key] = { value: r.value, source: r.source, default: r.defaultValue };
		console.log(JSON.stringify(obj, null, 2));
		return 0;
	}
	console.log("Quality-metric caps  (change: interlinked caps set <metric> <value>):");
	for (const r of rows) console.log(`  ${formatCapShowRow(r)}`);
	console.log("Run `interlinked caps explain` for what each metric means.");
	return 0;
}

/** Parse an existing metric-caps.json into a plain object; {} on absent, malformed
 *  JSON, or JSON that parses to a non-object shape (array/string/number — valid
 *  JSON, wrong shape) — all three take the same documented overwrite-cleanly path. */
function readExisting(path: string): JsonObject {
	try {
		if (!existsSync(path)) return {};
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isJsonObject(parsed) ? parsed : {}; // wrong shape → overwrite cleanly
	} catch {
		return {}; // malformed → overwrite cleanly
	}
}

/** Validate a proposed cap value for `metricKey`; null when valid, else an error. */
function validateValue(metricKey: string, n: number): string | null {
	if (!Number.isFinite(n)) return "value must be a number";
	if (metricKey === "coverage") {
		return n < 1 || n > COVERAGE_SCALE_MAX
			? "coverage goal must be between 1 and 100 (it is a target, not a cap — 100 is the scale's own ceiling)"
			: null;
	}
	return n <= 0 ? `${metricKey} cap must be a positive number` : null;
}

/** `interlinked caps set <metric> <value>` — write one cap to metric-caps.json. */
export async function capsSetAction(
	metric: string,
	value: string,
	opts: { json?: boolean },
	deps: { cwd?: string } = {},
): Promise<number> {
	const cwd = deps.cwd ?? process.cwd();
	const def = METRIC_DEFS.find((d) => d.key === metric);
	if (!def) {
		console.error(`Unknown metric "${metric}". Valid: ${METRIC_DEFS.map((d) => d.key).join(", ")}.`);
		return 1;
	}
	const n = Number(value);
	const invalid = validateValue(def.key, n);
	if (invalid) {
		console.error(`Cannot set ${def.key}: ${invalid} (got "${value}").`);
		return 1;
	}
	const dir = join(cwd, ".interlinked");
	const path = join(dir, "metric-caps.json");
	const next = { version: 1, ...readExisting(path), [def.configKey]: n };
	// Create .interlinked/ when absent so `caps set` works before `interlinked
	// enable` (or in any repo lacking it) instead of throwing ENOENT — the
	// committed metric-caps.json is a policy file, not a runtime artifact that
	// presupposes enablement (finding 2026-06, round 8). recursive ⇒ idempotent.
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	resetMetricCapsCache();
	if (opts.json) {
		console.log(JSON.stringify({ metric: def.key, value: n, configKey: def.configKey }));
		return 0;
	}
	console.log(`Set ${def.label} cap → ${n}  (${def.configKey} in .interlinked/metric-caps.json).`);
	return 0;
}

/** `interlinked caps explain [metric]` — print the glossary for all or one metric. */
export async function capsExplainAction(
	metric: string | undefined,
	opts: { json?: boolean },
	_deps: { cwd?: string } = {},
): Promise<number> {
	const defs = metric ? METRIC_DEFS.filter((d) => d.key === metric) : [...METRIC_DEFS];
	if (metric && defs.length === 0) {
		console.error(`Unknown metric "${metric}". Valid: ${METRIC_DEFS.map((d) => d.key).join(", ")}.`);
		return 1;
	}
	if (opts.json) {
		console.log(
			JSON.stringify(
				defs.map((d) => ({
					key: d.key,
					label: d.label,
					definition: d.definition,
					default: d.defaultValue,
					stricter: d.stricter,
					howToConfigure: d.howToConfigure,
					fixHint: d.fixHint,
				})),
				null,
				2,
			),
		);
		return 0;
	}
	for (const d of defs) {
		const unit = d.unit ? ` ${d.unit}` : "";
		console.log(`${d.label} (${d.key})`);
		console.log(`  ${d.definition}`);
		console.log(`  Default: ${d.defaultValue}${unit} · ${d.stricter} is stricter`);
		console.log(`  Configure: ${d.howToConfigure}`);
		console.log(`  Fix: ${d.fixHint}`);
		console.log("");
	}
	return 0;
}
