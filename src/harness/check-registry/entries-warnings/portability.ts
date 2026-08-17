// Portability lint wave (Plan 25 lane 6,
// docs/plans/25-refactor-readiness-program.md): three new post-phase,
// advisory detectors for constructs that defeat static analysis and porting
// agents. See checks/portability.ts for full detection rationale, including
// the deliberate overlap with the pre_block `eval_usage` hard rail.

import {
	detectBuiltinPrototypeMutation,
	detectDynamicCodeExecution,
	detectFloatEqualityComparison,
} from "../../checks/portability.js";
import type { CheckRegistration } from "../types.js";

export const PORTABILITY_ENTRIES: CheckRegistration[] = [
	{
		id: "dynamic_code_execution",
		phase: "post",
		name: "Dynamic Code Execution",
		description:
			"Detects eval(, new Function(, require(<non-literal>), and import(<non-literal>) — constructs where the executed code is not visible in the source text, defeating every static analyzer and every porting agent",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace dynamic code execution with an explicit, statically-visible alternative: a lookup table/switch for a small known set of modules instead of require(computedPath), a literal import specifier, or a real parser instead of eval/new Function. If the path truly must be computed, keep the computation local and add a comment explaining why a static alternative isn't possible.",
		fn: detectDynamicCodeExecution,
		resultsPropName: "dynamicCodeExecution",
		content_keywords: ["eval", "Function", "require", "import"],
	},
	{
		id: "builtin_prototype_mutation",
		phase: "post",
		name: "Builtin Prototype Mutation",
		description:
			"Detects monkey-patching of a built-in's prototype (String.prototype.X =, Array.prototype.X =, ...) or reassignment of a global builtin (Array =, JSON =, globalThis.JSON =, ...) — patterns with no equivalent in most other languages",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace the monkey-patch with a plain function or a wrapper module (`function flatMapPolyfill(arr, fn) {...}` instead of `Array.prototype.flatMap = ...`). A porting agent has nowhere to put a mutated builtin in a target language — an ordinary exported function ports directly.",
		fn: detectBuiltinPrototypeMutation,
		resultsPropName: "builtinPrototypeMutation",
		content_keywords: ["prototype", "="],
	},
	{
		id: "float_equality_comparison",
		phase: "post",
		name: "Float Equality Comparison",
		description:
			"Detects === / !== where one operand is a float literal (contains a dot) — both a rounding-bug class and a cross-language numeric-model trap",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Compare with a tolerance instead of exact equality: `Math.abs(a - b) < Number.EPSILON` (or a domain-appropriate epsilon), not `a === 0.1`. Exact float equality rarely holds after any arithmetic, and the same literal can compare differently under another language's float representation.",
		fn: detectFloatEqualityComparison,
		resultsPropName: "floatEqualityComparison",
		content_keywords: ["===", "!=="],
	},
];
