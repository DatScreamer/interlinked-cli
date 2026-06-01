// Metadata fragment: Batch 1 agent-laziness checks — stubs, dead branches,
// suppressions, casts, and the network/perf shapes agents reach for when
// cutting corners. Composed into GENERIC_CHECK_META in ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_AGENT_LAZINESS_META: Record<string, CheckMeta> = {
	// ========================================================================
	// Batch 1: agent-laziness (11 entries)
	// ========================================================================
	agent_thumbprint_prose: {
		name: "Agent Thumbprint Prose",
		description:
			"Detects literal phrases LLMs use when giving up — placeholder narratives left in comments instead of finishing the work.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	stub_not_implemented_throw: {
		name: "Stub Not-Implemented Throw",
		description:
			"Detects `throw new Error(\"not implemented\" | \"TODO\" | \"stub\" | ...)` and empty `throw new Error()` in non-test source.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	dead_branch_literal: {
		name: "Dead Branch Literal",
		description:
			"Detects `if (true)` / `if (false)` / `else if (true)` debugger artifacts that bypass real control flow.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	file_level_suppression: {
		name: "File-Level Suppression",
		description:
			"Detects file-wide suppression directives (ts-nocheck, eslint-disable with no rule list, biome-ignore-all, pylint disable=all).",
		tier: 1,
		determinism: "fully_deterministic",
	},
	untestable_time_in_source: {
		name: "Untestable Nondeterminism",
		description:
			"Detects inline Date.now / new Date() / Math.random / crypto.randomUUID / performance.now in non-test source — requires injection point.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	double_cast_unknown: {
		name: "Double-Cast via Unknown",
		description:
			"Detects `as unknown as Foo` — agents reach for this when a single `as` won't satisfy TypeScript.",
		tier: 2,
		determinism: "partially_deterministic",
	},
	type_smuggling: {
		name: "Type-Smuggling Cast",
		description:
			"Detects `as T` casts where the source expression's static type has no structural overlap with `T` — the cast lies, instead of narrowing or widening. TypeScript compiler API; `as unknown`/`as any`/`as const` are exempt.",
		tier: 3,
		determinism: "partially_deterministic",
	},
	union_widened_with_string: {
		name: "Union Widened With Bare String",
		description:
			"Detects `\"a\" | \"b\" | string` — TypeScript narrows the union back to `string`, defeating the literal alternatives.",
		tier: 2,
		determinism: "heuristic",
	},
	nodeenv_branch_in_prod: {
		name: "NODE_ENV Branch in Production",
		description:
			"Detects `process.env.NODE_ENV === \"test\"` (or development/staging/local) inside non-test, non-config source.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	fetch_without_timeout: {
		name: "Fetch / Axios Without Timeout",
		description:
			"Detects fetch() and axios calls without `signal:` / `timeout:` / AbortController in their options.",
		tier: 1,
		determinism: "heuristic",
	},
	unbounded_promise_all: {
		name: "Promise.all on Unbounded Array",
		description:
			"Detects `Promise.all(<ident>.map(asyncFn))` patterns — fans out N parallel requests for an N-sized input.",
		tier: 2,
		determinism: "heuristic",
	},
	sync_io_on_hot_path: {
		name: "Synchronous I/O on Hot Path",
		description:
			"Detects *Sync (readFileSync / execSync / etc.) inside HTTP handler / route / middleware files.",
		tier: 2,
		determinism: "heuristic",
	},
};
