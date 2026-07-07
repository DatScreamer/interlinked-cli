// Quality-frontier wave (2026-07-06): eight post-phase warnings generalized
// from the LLM-defect research sweep + repo gap-scan (docs/design/
// quality-frontier-2026-07.md). Detectors live in their own checks/ family
// files and are imported directly (the generic-checks.ts barrel is legacy
// back-compat surface; see its header).

import {
	detectContradictoryNullnessChain,
	detectImplicitSwitchFallthrough,
	detectNumericSortWithoutComparator,
} from "../../checks/correctness-misc.js";
import {
	detectCatchRewrapLosesCause,
	detectJsonStringifyError,
	detectResourceHandleLeak,
} from "../../checks/error-context.js";
import { detectJsdocParamDrift } from "../../checks/jsdoc-param-drift.js";
import { detectTimeoutUnitMismatch } from "../../checks/unit-mismatch.js";
import type { CheckRegistration } from "../types.js";

export const QUALITY_FRONTIER_ENTRIES: CheckRegistration[] = [
	{
		id: "timeout_unit_mismatch",
		phase: "post",
		name: "Timeout Unit Mismatch",
		description:
			"Detects a seconds-named identifier (delaySeconds, timeoutSec, retry_s) passed directly as the setTimeout/setInterval delay argument — milliseconds expected, so the timer fires ~1000x early — and the inverse, an ms-named identifier multiplied by 1000 inline at the call site (double conversion, ~1000x late).",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"setTimeout/setInterval take a MILLISECOND delay. If the value is in seconds, convert at the call site (`setTimeout(fn, delaySeconds * 1000)`); if it is already in milliseconds, pass it directly and drop any `* 1000` — or rename the variable so its unit matches its value.",
		fn: detectTimeoutUnitMismatch,
		resultsPropName: "timeoutUnitMismatch",
		content_keywords: ["setTimeout", "setInterval"],
	},
	{
		id: "numeric_sort_without_comparator",
		phase: "post",
		name: "Numeric Sort Without Comparator",
		description:
			"Detects .sort() with no comparator where the receiver is provably numeric from syntax alone — a numeric array literal, or an identifier declared in-file with an explicit number[] / Array<number> annotation. Default Array.prototype.sort is lexicographic, so [10, 9, 1].sort() yields [1, 10, 9].",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Default .sort() coerces elements to strings and sorts lexicographically, so numbers order wrong ([10, 9, 1] → [1, 10, 9]). Pass a numeric comparator: .sort((a, b) => a - b) ascending, (a, b) => b - a descending.",
		fn: detectNumericSortWithoutComparator,
		resultsPropName: "numericSortWithoutComparator",
		content_keywords: [".sort("],
	},
	{
		id: "implicit_switch_fallthrough",
		phase: "post",
		name: "Implicit Switch Fallthrough",
		description:
			"Detects a non-empty switch case whose last statement is not break/return/throw/continue while a following clause exists, via the TS AST (silently skips when the optional typescript dep is absent). Empty case-grouping and a trailing // falls through comment are exempt.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Execution falls into the next case clause. End the clause with break/return/throw, or — if the fallthrough is intentional — mark it with a trailing // falls through comment (the eslint no-fallthrough convention).",
		fn: detectImplicitSwitchFallthrough,
		resultsPropName: "implicitSwitchFallthrough",
		content_keywords: ["switch"],
	},
	{
		id: "contradictory_nullness_chain",
		phase: "post",
		name: "Contradictory Nullness Chain",
		description:
			"Detects an optional chain immediately non-null asserted on the same chain (a?.b!.c, a?.[i]!, (a?.b)!) — the ! claims the value cannot be absent while the ?. claims it may be. Typically a churn artifact from appeasing tsc; a strong cold-reader confusion signal. TS files only.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The ?. and ! on the same chain contradict each other. Pick one: keep the optional chain and handle the undefined case (a?.b?.c, or ?? fallback), or — if non-null is a real invariant — prove it and drop the ?. (a!.b, better: a narrowing check).",
		fn: detectContradictoryNullnessChain,
		resultsPropName: "contradictoryNullnessChain",
		content_keywords: ["?."],
	},
	{
		id: "json_stringify_error",
		phase: "post",
		name: "JSON.stringify of Caught Error",
		description:
			"Detects JSON.stringify(<catch binding>) passed bare inside a catch block (including with replacer/indent args that keep the binding bare, and inside template literals) — Error own-properties (message/stack/name) are non-enumerable, so the output is `{}` and the log line loses everything.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"JSON.stringify on an Error yields {} because message/name/stack are non-enumerable. Log the fields explicitly ({ message: err.message, stack: err.stack }), pass the error object to the logger, or use JSON.stringify(err, Object.getOwnPropertyNames(err)).",
		fn: detectJsonStringifyError,
		resultsPropName: "jsonStringifyError",
		content_keywords: ["JSON.stringify", "catch"],
	},
	{
		id: "catch_rewrap_loses_cause",
		phase: "post",
		name: "Catch Rewrap Loses Cause",
		description:
			"Detects a new Error constructed inside catch(<id>) that references the caught binding ONLY via string coercion (concat, String(), .toString(), template interpolation, property read) — with no { cause: id } option and no bare id argument. The original stack and cause chain are destroyed. The error-normalization ternary (e instanceof Error ? e : new Error(String(e))) is exempt.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add { cause: err } (ES2022, Node 16.9+/TS 4.6+) to the wrapper constructor or pass the caught error itself to the error class — stringifying it into the message drops the stack and severs the .cause chain.",
		fn: detectCatchRewrapLosesCause,
		resultsPropName: "catchRewrapLosesCause",
		content_keywords: ["catch", "new Error"],
	},
	{
		id: "resource_handle_leak",
		phase: "post",
		name: "Resource Handle Leak",
		description:
			"Detects an fs.openSync fd or fs.createWriteStream binding that is never closed/ended/destroyed and never handed off (return/yield/pipe/pipeline/finished/alias/store/resolve/push) anywhere downstream — the handle leaks on every path. Narrow zero-noise slice per docs/design/effect-ts-harness-additions.md §2.5.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Release the handle in a finally block (fs.closeSync(fd) / stream.end()) or declare it with `using`/`await using` so every exit path closes it.",
		fn: detectResourceHandleLeak,
		resultsPropName: "resourceHandleLeak",
		content_keywords: ["openSync", "createWriteStream"],
	},
	{
		id: "jsdoc_param_drift",
		phase: "post",
		name: "JSDoc Param Drift",
		description:
			"Detects a JSDoc @param tag naming a parameter that does not exist on the documented function — stale documentation after a rename or removal. Parsed with the TS compiler API (silently skips when the optional typescript dep is absent); destructured params, rest params, dotted @param options.x forms, and overload sets are exempt, so a fire is a true drift.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The @param tag names a parameter the function no longer has. Rename the tag to match the current signature, or delete it if the parameter was removed — stale param docs actively mislead the next reader.",
		fn: detectJsdocParamDrift,
		resultsPropName: "jsdocParamDrift",
		content_keywords: ["@param"],
	},
];
