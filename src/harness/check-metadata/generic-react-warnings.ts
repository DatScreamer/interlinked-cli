// Metadata fragment: warning-severity lint/React smell checks (partially
// deterministic + heuristic). Composed into GENERIC_CHECK_META in ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_REACT_WARNINGS_META: Record<string, CheckMeta> = {
	// Warning severity — partially deterministic
	extraneous_deps: {
		name: "Extraneous Dependencies",
		description: "Detects imported packages not in package.json",
		tier: 2,
		determinism: "partially_deterministic",
	},
	non_null_assertion: {
		name: "Non-Null Assertion",
		description: "Detects TypeScript non-null assertions (!)",
		tier: 2,
		determinism: "partially_deterministic",
	},
	constant_condition: {
		name: "Constant Condition",
		description: "Detects always-true/false conditions",
		tier: 2,
		determinism: "partially_deterministic",
	},
	number_precision_loss: {
		name: "Number Precision Loss",
		description: "Detects integer literals beyond safe precision",
		tier: 2,
		determinism: "fully_deterministic",
	},
	require_await: {
		name: "Require Await",
		description: "Detects async functions without await",
		tier: 2,
		determinism: "partially_deterministic",
	},
	json_parse_unsafe: {
		name: "JSON Parse Unsafe",
		description: "Detects JSON.parse without try/catch",
		tier: 2,
		determinism: "partially_deterministic",
	},

	// Warning severity — heuristic
	accumulating_spread: {
		name: "Accumulating Spread",
		description: "Detects spread operator in reduce (O(n^2))",
		tier: 2,
		determinism: "heuristic",
	},
	excessive_use_state: {
		name: "Excessive useState",
		description: "Detects components with too many useState hooks",
		tier: 3,
		determinism: "heuristic",
	},
	direct_dom_access: {
		name: "Direct DOM Access",
		description: "Detects direct DOM manipulation in React components",
		tier: 3,
		determinism: "heuristic",
	},
	inline_object_props: {
		name: "Inline Object Props",
		description: "Detects inline object/array creation in JSX props",
		tier: 3,
		determinism: "heuristic",
	},
	async_event_handler: {
		name: "Async Event Handler",
		description: "Detects async event handlers that may cause unmounted-component issues",
		tier: 3,
		determinism: "heuristic",
	},
	nested_ternaries: {
		name: "Nested Ternaries",
		description: "Detects nested ternary expressions",
		tier: 2,
		determinism: "heuristic",
	},
	catch_and_log: {
		name: "Catch and Log",
		description: "Detects catch blocks that only log and rethrow",
		tier: 3,
		determinism: "heuristic",
	},
	hardcoded_timeout: {
		name: "Hardcoded Timeout",
		description: "Detects magic number timeouts (setTimeout/setInterval)",
		tier: 3,
		determinism: "heuristic",
	},
	sequential_awaits: {
		name: "Sequential Awaits",
		description: "Detects sequential await calls that could be parallelized",
		tier: 3,
		determinism: "heuristic",
	},
	index_as_key: {
		name: "Index as Key",
		description: "Detects array index used as React key prop",
		tier: 3,
		determinism: "heuristic",
	},
	missing_effect_cleanup: {
		name: "Missing Effect Cleanup",
		description: "Detects useEffect with subscriptions but no cleanup",
		tier: 3,
		determinism: "heuristic",
	},
	over_mocking: {
		name: "Over-Mocking",
		description: "Detects excessive mocking in test files",
		tier: 3,
		determinism: "heuristic",
	},
	excessive_use_effect: {
		name: "Excessive useEffect",
		description: "Detects components with too many useEffect hooks",
		tier: 3,
		determinism: "heuristic",
	},
};
