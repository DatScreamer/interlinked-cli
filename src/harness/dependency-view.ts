// ===========================================
// DependencyView — provider seam for dependency-aware queries
// ===========================================
// A narrow read interface over the *dependents / blast-radius / callers /
// classifyModule* query set. Two backends satisfy it:
//
//   - InternalDependencyView — wraps the in-memory regex `ProjectGraph`.
//     Always available; the tested default; what every non-Supermodel repo
//     gets. No call graph (`getCallers` → []), no transitive BFS in v1
//     (`getBlastRadius.transitive === direct`).
//   - SupermodelDependencyView — wraps a loaded, AST-derived Supermodel
//     `.graph` shard. Adds function-level callers and a real transitive
//     count from the shard's `[impact]` section.
//
// `resolveDependencyView` picks the backend per-file via the prediction
// protocol's existing freshness gate (`classifyCase`): only a fresh shard
// (Case `E-fresh`) yields the Supermodel view; every other case — no
// Supermodel, greenfield file, no shard, stale shard, or a shard that
// fails to load — falls back to the internal graph.
//
// The seam is deliberately NARROW (plan-08 §3b): cycles, duplicate
// symbols, import resolution, and dead/hallucinated imports stay on
// `ProjectGraph` directly — a per-file shard cannot answer whole-repo
// queries. This file is purely additive; when `source === "internal"`
// every consumer behaves byte-identically to the pre-seam code.

import {
	classifyCase,
	type GraphPredictionCase,
} from "./graph-prediction-classifier.js";
import type { ProjectGraph } from "./project-graph.js";
import { loadGraphForFile, type SupermodelGraph } from "./supermodel-graph.js";
import type { ModuleRole } from "./types.js";

/** The single prediction-protocol case for which a Supermodel shard is
 *  trustworthy: it exists and its mtime is at/after the source mtime.
 *  Reusing this constant — rather than a parallel staleness heuristic —
 *  is what keeps the seam's freshness gate identical to the prediction
 *  protocol's (plan-08 §3b). */
const TRUSTWORTHY_SHARD_CASE: GraphPredictionCase = "E-fresh";

/** Blast-radius shape — direct + transitive dependent counts + domains. */
export interface BlastRadius {
	/** File-granularity count of direct dependents. */
	direct: number;
	/** Files transitively reachable through the import/call graph. For the
	 *  internal view this equals `direct` (no BFS in v1 — plan-08 OQ 2). */
	transitive: number;
	/** Domain labels for the dependents. `[]` for the internal view. */
	domains: string[];
}

/** A function-level caller site. */
export interface CallerSite {
	/** The function defined in this file that is being called. */
	fn: string;
	/** The calling function. */
	caller: string;
	/** File containing the caller. */
	file: string;
	/** 1-based line of the call site, or 0 when the shard omitted it. */
	line: number;
}

/**
 * Narrow read interface over the dependents / blast-radius / callers /
 * classifyModule query set. Backed by either the internal `ProjectGraph`
 * or a Supermodel `.graph` shard — `source` records which.
 */
export interface DependencyView {
	/** Files that import or call into this file. */
	getDependents(file: string): string[];
	/** Classify this file's role in the dependency graph. */
	classifyModule(file: string): ModuleRole;
	/** Blast radius — direct + transitive dependent counts + domains.
	 *  `null` when the backend cannot answer (Supermodel shard with no
	 *  `[impact]` section). The internal view always answers. */
	getBlastRadius(file: string): BlastRadius | null;
	/** Function-level callers. Supermodel only; `[]` for the internal graph. */
	getCallers(file: string): CallerSite[];
	/** Provenance — which backend answered. Flows into warning wording. */
	readonly source: "supermodel" | "internal";
}

// ===========================================
// Internal backend — wraps ProjectGraph
// ===========================================

/**
 * `DependencyView` backed by the in-memory regex `ProjectGraph`. Available
 * on every repo. No call graph and no transitive BFS — `getCallers` is `[]`
 * and `getBlastRadius.transitive` equals `direct` (plan-08 open question 2).
 */
export class InternalDependencyView implements DependencyView {
	readonly source = "internal" as const;

	constructor(private readonly graph: ProjectGraph) {}

	getDependents(file: string): string[] {
		return this.graph.getDependents(file);
	}

	classifyModule(file: string): ModuleRole {
		return this.graph.classifyModule(file);
	}

	getBlastRadius(file: string): BlastRadius {
		const direct = this.graph.getDependents(file).length;
		// v1: no internal reverse-graph BFS — report `direct` as the
		// transitive count too. A memoized BFS is a cheap follow-on.
		return { direct, transitive: direct, domains: [] };
	}

	getCallers(_file: string): CallerSite[] {
		// The regex graph has no function-level call edges.
		return [];
	}
}

// ===========================================
// Supermodel backend — wraps a loaded .graph shard
// ===========================================

/** `direct` count at or above which a file is treated as a hub. Mirrors
 *  `ProjectGraph.classifyModule`'s 5-dependent hub threshold. */
const SUPERMODEL_HUB_THRESHOLD = 5;

/**
 * `DependencyView` backed by a loaded Supermodel `.graph` shard. The shard
 * is a per-file sidecar, so every query is answered for the file the shard
 * describes regardless of the `file` argument; `resolveDependencyView`
 * guarantees the shard matches the file under analysis.
 */
export class SupermodelDependencyView implements DependencyView {
	readonly source = "supermodel" as const;

	constructor(private readonly shard: SupermodelGraph) {}

	getDependents(_file: string): string[] {
		// Union of `[deps] imported-by` and `[impact] affects`. Both list
		// files that depend on the source; the union covers importers plus
		// any caller-only file the impact section adds.
		const seen = new Set<string>();
		const result: string[] = [];
		for (const f of this.shard.deps?.importedBy ?? []) {
			if (!seen.has(f)) {
				seen.add(f);
				result.push(f);
			}
		}
		for (const f of this.shard.impact?.affects ?? []) {
			if (!seen.has(f)) {
				seen.add(f);
				result.push(f);
			}
		}
		return result;
	}

	classifyModule(_file: string): ModuleRole {
		// Derived from the shard's `[impact]` section: HIGH risk or a large
		// direct fan-out is a hub; any dependents at all is internal; none
		// is a leaf. `root` is an import-graph property the per-file shard
		// cannot determine, so it is never returned here.
		const impact = this.shard.impact;
		if (!impact) return "leaf";
		if (impact.risk === "HIGH" || impact.direct >= SUPERMODEL_HUB_THRESHOLD) {
			return "hub";
		}
		if (impact.direct >= 1) return "internal";
		return "leaf";
	}

	getBlastRadius(_file: string): BlastRadius | null {
		const impact = this.shard.impact;
		if (!impact) return null;
		return {
			direct: impact.direct,
			transitive: impact.transitive,
			domains: [...impact.domains],
		};
	}

	getCallers(_file: string): CallerSite[] {
		return (this.shard.calls?.callers ?? []).map((c) => ({
			fn: c.fn,
			caller: c.caller,
			file: c.file,
			line: c.line,
		}));
	}
}

// ===========================================
// Resolver
// ===========================================

/**
 * Pick the `DependencyView` backend for `file`.
 *
 * Calls the prediction protocol's `classifyCase` and reuses its freshness
 * gate verbatim — no second staleness heuristic to drift. Only a fresh
 * shard (Case `E-fresh`) yields a `SupermodelDependencyView`; every other
 * case (`A`/`B`/`C`/`D`/`E-stale`) — and a fresh shard that nonetheless
 * fails to load or parse — falls back to `InternalDependencyView`.
 *
 * `graph` is always passed so the internal fallback is available without a
 * second construction; non-Supermodel repos pay only the `classifyCase`
 * cost (a cached workspace-active check).
 */
export function resolveDependencyView(
	file: string,
	cwd: string,
	graph: ProjectGraph,
): DependencyView {
	let result: ReturnType<typeof classifyCase>;
	try {
		result = classifyCase(file, cwd);
	} catch {
		// classifyCase touches the filesystem; any failure → internal.
		return new InternalDependencyView(graph);
	}

	if (result.case !== TRUSTWORTHY_SHARD_CASE) {
		return new InternalDependencyView(graph);
	}

	const shard = loadGraphForFile(result.sourcePath);
	if (!shard) {
		// Fresh per classifyCase, but the shard would not load/parse —
		// fall back rather than guess.
		return new InternalDependencyView(graph);
	}
	return new SupermodelDependencyView(shard);
}
