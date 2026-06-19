// interlinked-tdd: exempt
// ===========================================
// interlinked metrics — report types + human-readable renderers
// ===========================================
// The MetricsReport shape and the `short` / `normal` output formatters for
// `interlinked metrics`, split out of metrics.ts to keep that orchestrator under
// the per-file line cap. Pure presentation + data shapes: the renderers take a
// MetricsReport and return a string. No I/O, no recomputation — same code, just
// relocated. metrics.ts imports these back.

import { c, header, kvLine } from "../lib/formatter.js";

export interface FnMetric {
	file: string;
	name: string;
	line: number;
	cyclomatic: number;
	/** null when no coverage data is available for the file. */
	coveragePct: number | null;
	/** null when no coverage data is available (CRAP needs coverage). */
	crap: number | null;
}

export interface FileMetric {
	file: string;
	functions: number;
	/** Per-file line coverage %, or null when no coverage report is present. */
	linePct: number | null;
	maxCyclomatic: number;
	/** null when no coverage data. */
	maxCrap: number | null;
	/** true/false when a companion is expected, null when the file is exempt. */
	companion: boolean | null;
	/** functions in this file at/over the CRAP gate. */
	overGate: number;
}

export interface MetricsReport {
	scope: {
		files: number;
		functions: number;
		coverageAvailable: boolean;
		coverageSource: "istanbul" | "lcov" | "istanbul+lcov" | null;
		astComplexityAvailable: boolean;
	};
	/** The resolved caps the gates actually enforce for this repo — read from
	 *  `.interlinked/metric-caps.json` (else the shipped defaults). The rendered
	 *  labels + the gate COUNTS derive from these, so the report can never show a
	 *  threshold that disagrees with what the write/commit gates enforce. */
	caps: {
		/** Per-function CRAP cap (`crapThresholdFor`). Functions at/over it are over-gate. */
		crap: number;
		/** Per-function cyclomatic "bad" cap (`maxCyclomaticFor`). */
		cyclomatic: number;
		/** Cyclomatic "review" band lower bound. The review band counts functions in
		 *  `(cyclomaticReview, cyclomatic]`. Threaded so the renderer reads the same
		 *  band edges the command computed (historical default: 15 → "16–25"). */
		cyclomaticReview: number;
	};
	gates: {
		functionsOverCrap: number;
		functionsCyclomaticReview: number;
		functionsCyclomaticBad: number;
		filesMissingCompanion: number;
		filesNoCoverage: number;
	};
	distributions: {
		cyclomatic: Record<string, number>;
		crap: Record<string, number>;
	};
	hotspots: FnMetric[];
	missingCompanion: string[];
	files: FileMetric[];
}

// Thresholds are NOT hard-coded here any more: they are RESOLVED once in
// metrics.ts (`crapThresholdFor` / `maxCyclomaticFor`, reading
// `.interlinked/metric-caps.json`) and threaded in via `r.caps`, so the rendered
// labels read exactly the numbers the write/commit gates enforce. The shipped
// defaults (CRAP 30, cyclomatic 25) make the output identical when uncustomized.

export function renderShort(r: MetricsReport): string {
	const cov = r.scope.coverageAvailable ? "" : " (no coverage)";
	return `${r.scope.files} files · ${r.scope.functions} fns · CRAP≥${r.caps.crap}: ${r.gates.functionsOverCrap} · cyc>${r.caps.cyclomatic}: ${r.gates.functionsCyclomaticBad} · no-companion: ${r.gates.filesMissingCompanion}${cov}`;
}

export function renderNormal(r: MetricsReport): string {
	const lines: string[] = [];
	lines.push(header("Test-Quality Metrics"));
	lines.push(kvLine("Source files", String(r.scope.files)));
	lines.push(kvLine("Functions", String(r.scope.functions)));
	const covLabel = r.scope.coverageAvailable
		? c.green(`present (${r.scope.coverageSource})`)
		: c.yellow("absent (CRAP/coverage unavailable — run `npm run test:coverage`)");
	lines.push(kvLine("Coverage", covLabel));
	if (!r.scope.astComplexityAvailable) {
		lines.push(
			kvLine(
				"Complexity",
				c.yellow("regex fallback — `typescript` not resolvable; install it for AST-accurate metrics"),
			),
		);
	}
	lines.push("");
	lines.push(c.bold("  Gates"));
	lines.push(kvLine(`  CRAP ≥ ${r.caps.crap}`, gateStr(r.gates.functionsOverCrap), 22));
	lines.push(kvLine(`  cyclomatic > ${r.caps.cyclomatic}`, gateStr(r.gates.functionsCyclomaticBad), 22));
	lines.push(
		kvLine(
			`  cyclomatic ${r.caps.cyclomaticReview + 1}–${r.caps.cyclomatic}`,
			String(r.gates.functionsCyclomaticReview),
			22,
		),
	);
	lines.push(kvLine("  files no companion", gateStr(r.gates.filesMissingCompanion), 22));
	if (r.scope.coverageAvailable) {
		lines.push(kvLine("  files no coverage", String(r.gates.filesNoCoverage), 22));
	}
	lines.push("");
	lines.push(c.bold("  CRAP distribution"));
	for (const [bucket, n] of Object.entries(r.distributions.crap)) {
		lines.push(`    ${bucket.padEnd(10)} ${n}`);
	}
	lines.push("");
	lines.push(c.bold(`  Top ${r.hotspots.length} CRAP hotspots`));
	if (r.hotspots.length === 0) {
		lines.push(c.dim("    (no coverage data — CRAP unavailable)"));
	}
	for (const h of r.hotspots) {
		lines.push(
			`    ${String(Math.round(h.crap ?? 0)).padStart(6)}  cyc=${String(h.cyclomatic).padStart(3)}  cov=${String(Math.round(h.coveragePct ?? 0)).padStart(3)}%  ${h.file}::${h.name}`,
		);
	}
	if (r.missingCompanion.length > 0) {
		lines.push("");
		lines.push(c.bold(`  Files missing a companion test (${r.missingCompanion.length})`));
		for (const f of r.missingCompanion.slice(0, 25)) lines.push(`    ${c.yellow("✗")} ${f}`);
		if (r.missingCompanion.length > 25) {
			lines.push(c.dim(`    … and ${r.missingCompanion.length - 25} more`));
		}
	}
	return lines.join("\n");
}

function gateStr(n: number): string {
	return n === 0 ? c.green("0") : c.red(String(n));
}
