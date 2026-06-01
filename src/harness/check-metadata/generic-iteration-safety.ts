// Metadata fragment: iteration / collection-mutation / cleanup / taint-flow
// checks (several ported from Firefox bug patterns). Composed into
// GENERIC_CHECK_META in ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_ITERATION_SAFETY_META: Record<string, CheckMeta> = {
	iterator_invalidation: {
		name: "Iterator Invalidation",
		description:
			"Detects mutating an array/Map/Set while iterating it — push/splice/delete/clear/set/add on the same collection inside for-of/for-in/forEach. JS analog of Firefox 2025977 (XSLT key() rehash freed backing store mid-iter).",
		tier: 1,
		determinism: "partially_deterministic",
	},
	fresh_collection_key_lookup: {
		name: "Fresh Collection Key Lookup",
		description:
			"Detects Map/Set .set/.get/.has/.add called with a fresh-identity value (NaN, empty/spread object literal, fresh Symbol, fresh `new` instance) — the lookup is a guaranteed miss",
		tier: 1,
		determinism: "partially_deterministic",
	},
	discriminated_union_exhaustiveness: {
		name: "Discriminated Union Exhaustiveness",
		description:
			"Detects TypeScript switch statements on literal-union or discriminated-union types where exhaustiveness is not asserted via a never-typed default branch — adding a new union member silently falls through with no compile-time error",
		tier: 2,
		determinism: "partially_deterministic",
	},
	index_bounds_unchecked: {
		name: "Index Bounds Unchecked",
		description:
			"Detects external-input numeric values (Number/parseInt/parseFloat applied to req.body|query|params or process.argv|env) reaching an array subscript without a Number.isFinite or length-bound guard. JS analog of Firefox 2026305 (16-bit overflow at 65535).",
		tier: 1,
		determinism: "partially_deterministic",
	},
	cleanup_skipped_on_early_exit: {
		name: "Cleanup Skipped on Early Exit",
		description:
			"Detects setInterval/setTimeout/subscribe/addEventListener acquisitions where a throw or return reaches before the matching release, with no try/finally wrap. JS analog of Firefox 2024653/2027298 (UAF via early exit during teardown).",
		tier: 2,
		determinism: "heuristic",
	},
	tainted_to_privileged_sink: {
		name: "Tainted to Privileged Sink",
		description:
			"Detects external-input values (req.body|query|params, process.argv|env) reaching a privileged sink (eval, new Function, vm.run*, child_process.exec*, fs.write*) without passing through a recognized validator. JS analog of Firefox 2023817 (parent process trusted sandbox-supplied input).",
		tier: 2,
		determinism: "heuristic",
	},
	await_state_toctou: {
		name: "Await State TOCTOU",
		description:
			"Detects `if (X.Y) { ... await ...; X.Y.method() }` shapes — same dotted field accessed before/after an await without re-check. JS analog of Firefox 2021894/2022733 (IPC race over async).",
		tier: 2,
		determinism: "heuristic",
	},
	cleanup_reentrancy: {
		name: "Cleanup Reentrancy",
		description:
			"Detects dispose/destroy/close/teardown methods that recurse into themselves or useEffect cleanups that mutate React state. JS analog of Firefox 2024653/2027298 (UAF via re-entry during teardown).",
		tier: 2,
		determinism: "heuristic",
	},
	boundary_copy_no_revalidation: {
		name: "Boundary Copy No Revalidation",
		description:
			"Detects Object.assign / spread copy of external input into a typed slot without a recognized validator on the source. JS analog of Firefox 2029813 (RLBox copy verification gap).",
		tier: 2,
		determinism: "heuristic",
	},
};
