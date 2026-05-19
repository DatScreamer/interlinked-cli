// Agent-clarity warning entries: cold-reader / agent-quality checks landed in
// the 2026-04 agent-quality rollout, plus the five comment-vs-behavior drift
// detectors (Mythos blog adaptation). Extracted from entries-warnings.ts —
// re-exported there as part of WARNING_ENTRIES.

import {
	checkCommentClaimsIdempotentMutates,
	checkCommentClaimsLimitNoGuard,
	checkCommentClaimsNullThrowsInstead,
	checkCommentClaimsThrowsDoesnt,
	checkCommentClaimsValidationMissing,
} from "../../generic-checks.js";
import {
	checkAwaitStateToctou,
	checkBooleanTrap,
	checkBoundaryCopyNoRevalidation,
	checkBroadObjectTypes,
	checkCircularImports,
	checkCleanupReentrancy,
	checkCleanupSkippedOnEarlyExit,
	checkCodeClones,
	checkDeadExports,
	checkDefaultExport,
	checkDiscriminatedUnionExhaustiveness,
	checkFreshCollectionKeyLookup,
	checkIndexBoundsUnchecked,
	checkIteratorInvalidation,
	checkLifecycleCleanup,
	checkMagicLiteralInConditional,
	checkSameTypedPrimitiveParams,
	checkTaintedToPrivilegedSink,
	checkUnvalidatedJsonBoundary,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const AGENT_CLARITY_ENTRIES: CheckRegistration[] = [
	{
		id: "default_export",
		phase: "post",
		name: "Default Export Hygiene",
		description:
			"Flags anonymous default exports or default exports whose symbol name does not match the filename — grep-hostile for cold readers",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Prefer a named export: `export function Foo() {}` + `import { Foo } from './foo'`. If you must use a default export (framework convention), give the symbol a name that matches the filename so grep and rename tools work: `export default function Foo() {}` in foo.ts. Anonymous `export default (...) => ...` is the worst case — rename to a named function.",
		fn: checkDefaultExport,
		resultsPropName: "defaultExport",
	},
	{
		id: "code_clones",
		phase: "post",
		name: "Code Clones (DRY)",
		description:
			"Jaccard-similarity clone detector (modeled on Uncle Bob's dry4* tools) — flags functions that are >=82% token-shingle-similar to another function in the same file or a sibling file",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Two functions share near-identical bodies. Extract the shared logic into one function and have both call sites delegate to it — parameterize the part that differs. Duplicated logic drifts: a bug fixed in one copy silently survives in the other. If the similarity is incidental (the shapes coincide but the intent is genuinely distinct), leave them separate.",
		fn: checkCodeClones,
		resultsPropName: "codeClones",
	},
	{
		id: "lifecycle_cleanup",
		phase: "post",
		name: "Lifecycle Cleanup",
		description:
			"Detects classes with a lifecycle method (dispose/destroy/close/unmount/stop) that register setInterval / setTimeout / addEventListener without the paired cleanup in the lifecycle body",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Store the handle returned by setInterval/setTimeout (or the listener function you passed to addEventListener) and pair it with clearInterval/clearTimeout/removeEventListener inside the lifecycle method. Otherwise the subscription outlives the class — a memory leak plus work that keeps happening after dispose.",
		fn: checkLifecycleCleanup,
		resultsPropName: "lifecycleCleanup",
	},
	{
		id: "circular_imports",
		phase: "post",
		name: "Circular Imports",
		description:
			"Detects import cycles involving the edited file (A → B → C → A) — unclear module boundaries that can cause runtime undefined-at-import-time bugs",
		tier: 3,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Break the cycle by moving shared types/constants to a third module that both sides depend on, or by flipping one edge to a type-only import (if it's only used in type positions). Cycles cause hard-to-debug `undefined` values at runtime because ES modules initialize one side before the other completes.",
		fn: (content, filePath) => checkCircularImports(content, filePath, process.cwd()),
		resultsPropName: "circularImports",
	},
	{
		id: "dead_exports",
		phase: "post",
		name: "Dead Exports",
		description:
			"Detects named exports that no other file in the project imports — inflates the apparent public surface for cold readers",
		tier: 3,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Either remove the unused export (so the public surface reflects what's actually consumed) or leave a comment explaining that it's deliberately part of the public API for external consumers. Cold readers — including agents — waste time trying to understand handles that nothing actually uses.",
		fn: (content, filePath) => checkDeadExports(content, filePath, process.cwd()),
		resultsPropName: "deadExports",
	},
	{
		id: "unvalidated_json_boundary",
		phase: "post",
		name: "Unvalidated JSON Boundary",
		description:
			"Detects `JSON.parse(...)` / `await <x>.json()` results that reach property access without passing through a schema parser (zod, valibot, ajv, yup, io-ts, arktype)",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Pipe the parsed value through a schema parser before using it: `const parsed = MySchema.parse(JSON.parse(raw));`. This gives you both a runtime validation error on malformed input AND a typed value downstream — cold readers see `parsed.field` and know the shape is guaranteed, not just a hope.",
		fn: checkUnvalidatedJsonBoundary,
		resultsPropName: "unvalidatedJsonBoundary",
	},
	{
		id: "magic_literal_in_conditional",
		phase: "post",
		name: "Magic Literal in Conditional",
		description:
			"Detects if/switch branches that compare against a bare numeric or string literal instead of a named constant — cold readers can't tell what the branch means",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Extract the literal into a named constant or enum so the conditional reads as intent. `if (status === ORDER_FULFILLED)` tells a cold reader what branch they're in; `if (status === 2)` forces them to grep for where 2 is defined.",
		fn: checkMagicLiteralInConditional,
		resultsPropName: "magicLiteralInConditional",
	},
	{
		id: "iterator_invalidation",
		phase: "post",
		name: "Iterator Invalidation",
		description:
			"Detects mutating an array, Map, or Set inside iteration over the same collection (push/splice/delete/clear/set/add inside for-of, for-in, forEach, or other iteration callbacks)",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Mutating the same collection you're iterating leads to skipped elements, double-visits, or in C++ analogs (Firefox bug 2025977) freed-backing-store UAFs. Either snapshot first (`for (const x of [...items]) { items.delete(x); }`), build a deletion list and apply it after the loop, or switch to a primitive that documents safe-during-iteration semantics (e.g. `filter` returning a new array).",
		fn: checkIteratorInvalidation,
		resultsPropName: "iteratorInvalidation",
	},
	{
		id: "fresh_collection_key_lookup",
		phase: "post",
		name: "Fresh Collection Key Lookup",
		description:
			"Detects Map/Set .set/.get/.has/.add called with a fresh-identity value (NaN, empty/spread object literal, fresh Symbol, fresh `new` instance) — the lookup is a guaranteed miss because identity differs from any previously inserted key",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`new Map().set({}, 1).get({})` returns `undefined` — the two `{}` literals have different identities. Use a stable key: a primitive (string/number, with NaN explicitly excluded), a value held in a variable across the set/get pair, or a WeakMap keyed on the stable object reference itself.",
		fn: checkFreshCollectionKeyLookup,
		resultsPropName: "freshCollectionKeyLookup",
	},
	{
		id: "discriminated_union_exhaustiveness",
		phase: "post",
		name: "Discriminated Union Exhaustiveness",
		description:
			"Detects TypeScript switch statements on literal-union or discriminated-union types where exhaustiveness is not asserted in the default branch — adding a new union member silently falls through the default with no compile-time error",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Either cover every case explicitly OR add an exhaustiveness assertion in the default branch. Three idioms work: (a) `default: { const _exhaustive: never = value; throw new Error('unreachable: ' + _exhaustive); }` — TS will refuse to compile when a new union member is added without a matching case; (b) `default: assertNever(value);` using a helper `function assertNever(x: never): never { throw new Error('unreachable: ' + x); }`; (c) `default: throw new UnreachableError(...);` paired with the assertion form. A bare `default: break;` or `default: return -1;` provides no compile-time safety against the next union member you forget to handle.",
		fn: checkDiscriminatedUnionExhaustiveness,
		resultsPropName: "discriminatedUnionExhaustiveness",
		content_keywords: ["switch"],
	},
	{
		id: "await_state_toctou",
		phase: "post",
		name: "Await State TOCTOU",
		description:
			"Detects `if (X.Y) { ... await ...; X.Y.method() }` shapes where the same dotted field is checked before an await and used after, with no re-check between. State may have changed during the await — use the value through the original reference at risk.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"After the await, re-verify the field exists before using it: `if (state.entry) { await sync(); if (state.entry) state.entry.touch(); }`. Or hoist the value to a local before the await: `const entry = state.entry; if (entry) { await sync(); entry.touch(); }` — the local survives the await regardless of whether `state.entry` was reassigned. Firefox bugs 2021894/2022733 were the C++ analog: IPC race over async boundaries.",
		fn: checkAwaitStateToctou,
		resultsPropName: "awaitStateToctou",
	},
	{
		id: "cleanup_reentrancy",
		phase: "post",
		name: "Cleanup Reentrancy",
		description:
			"Detects dispose/destroy/close/teardown methods that recurse into themselves, or useEffect cleanups that mutate React state — re-entry during teardown can fire another lifecycle event on a partially-destroyed instance",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"For class cleanup: guard recursion with a destroyed-flag (`if (this.destroyed) return; this.destroyed = true; ...`) or restructure so the cleanup is idempotent and only owns its own resources, not delegated re-cleanup. For useEffect: cleanups should release resources, not mutate state — calling setState in a cleanup triggers a render after teardown. Firefox bugs 2024653/2027298 were the C++ analog: UAF via re-entry during actor teardown.",
		fn: checkCleanupReentrancy,
		resultsPropName: "cleanupReentrancy",
	},
	{
		id: "boundary_copy_no_revalidation",
		phase: "post",
		name: "Boundary Copy No Revalidation",
		description:
			"Detects Object.assign / spread copy of external input (req.body|query|params, process.argv|env, JSON.parse output) into a typed slot without passing through a recognized validator first",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Validate before copying: `Object.assign(slot, Schema.parse(req.body))` or `const validated = Schema.parse(req.body); slot = { ...slot, ...validated };`. Without it, the typed slot now holds whatever shape the external input had — TypeScript types lie, runtime shape doesn't match the declared interface, and downstream code crashes on the unexpected shape. Firefox bug 2029813 was the C++ analog: RLBox copy verification gap.",
		fn: checkBoundaryCopyNoRevalidation,
		resultsPropName: "boundaryCopyNoRevalidation",
	},
	{
		id: "tainted_to_privileged_sink",
		phase: "post",
		name: "Tainted to Privileged Sink",
		description:
			"Detects external-input values (req.body|query|params, process.argv|env) reaching a privileged sink (eval, new Function, vm.run*, child_process.exec*, fs.write*) without passing through a recognized validator (zod/.parse, .safeParse, .validate, typeof, instanceof, Array.isArray, allow-list .has)",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Validate the value before it reaches the sink. Preferred: schema-parse it (`const cmd = CmdSchema.parse(req.body.cmd)`). Acceptable: typeof + allow-list (`if (typeof cmd !== 'string' || !ALLOW.has(cmd)) return`). Avoid passing un-narrowed external input to eval / new Function / child_process.exec / vm.run / fs.write — Firefox bug 2023817 was the C++ analog: the parent process trusted sandbox-supplied input that hadn't been re-validated at the trust boundary.",
		fn: checkTaintedToPrivilegedSink,
		resultsPropName: "taintedToPrivilegedSink",
	},
	{
		id: "cleanup_skipped_on_early_exit",
		phase: "post",
		name: "Cleanup Skipped on Early Exit",
		description:
			"Detects setInterval/setTimeout/subscribe/addEventListener acquisitions where a throw or return reaches before the matching release, with no try/finally wrap — the resource leaks on the early-exit path",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Wrap the acquisition + body in `try { ... } finally { <cleanup> }` so the cleanup runs on every exit path including thrown exceptions and early returns. Without it, the throw skips the cleanup, leaking the timer/listener/subscription. Firefox bug 2024653/2027298 — same shape, different language: the `try { ... } finally { ctrl.abort(); ws.close(); }` pattern is the JS-side fix.",
		fn: checkCleanupSkippedOnEarlyExit,
		resultsPropName: "cleanupSkippedOnEarlyExit",
	},
	{
		id: "index_bounds_unchecked",
		phase: "post",
		name: "Index Bounds Unchecked",
		description:
			"Detects external-input numeric values (Number/parseInt/parseFloat applied to req.body|query|params or process.argv|env) reaching an array subscript without a Number.isFinite or length-bound guard between parse and use",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Validate the parsed number before indexing: `if (!Number.isFinite(n) || n < 0 || n >= rows.length) return null; return rows[n];`. Without the guard, NaN/Infinity, negatives, or values past the end give `undefined` (or worse: silently match string-keyed properties). Firefox bug 2026305 was a 16-bit field overflow in this shape — same logic, different language.",
		fn: checkIndexBoundsUnchecked,
		resultsPropName: "indexBoundsUnchecked",
	},
	{
		id: "boolean_trap",
		phase: "post",
		name: "Boolean Trap",
		description:
			"Detects function calls with 2+ boolean literal arguments — the reader can't tell what each bool means without jumping to the definition",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace positional booleans with an options object so the intent is visible at the call site: `createUser('alice', { admin: true, verified: false })` instead of `createUser('alice', true, false)`. Alternatively, use an enum when the booleans represent a discrete mode.",
		fn: checkBooleanTrap,
		resultsPropName: "booleanTrap",
	},
	{
		id: "same_typed_primitive_params",
		phase: "post",
		name: "Same-Typed Primitive Params",
		description:
			"Detects exported / public-method signatures with two consecutive primitive parameters of the same surface type (string, number, boolean) — callers can swap them without a type error, so the ordering risk is structural, not a typo",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Two adjacent parameters of the same primitive type are orderable by mistake — `transfer(fromId: string, toId: string, amount: number)` compiles cleanly when called as `transfer(toId, fromId, amount)`. Make the illegal state unrepresentable: branded types (`type UserId = string & { __brand: 'UserId' }`, `type AccountId = string & { __brand: 'AccountId' }`) keep the runtime cost zero while the compiler now rejects the swapped call. Alternatively, take a single struct parameter and destructure by name: `transfer({ fromId, toId, amount }: { fromId: string; toId: string; amount: number })` — call sites become self-documenting and order-independent.",
		fn: checkSameTypedPrimitiveParams,
		resultsPropName: "sameTypedPrimitiveParams",
	},
	{
		id: "broad_object_types",
		phase: "pre_warn",
		name: "Broad Object Types",
		description:
			"Detects Record<K, any>, index signatures to any, and bare Function/object type annotations that hide shape information",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This type hides the shape of the value. Replace `Record<K, any>` / `{ [k: string]: any }` with a specific interface or typed map (e.g., `Record<UserId, UserProfile>`). Replace bare `Function` with a specific signature (`(x: number) => string`). Replace bare `object` with the actual object shape. Cold readers can't know what's expected otherwise.",
		fn: checkBroadObjectTypes,
		resultsPropName: "broadObjectTypes",
	},
	// === Comment-vs-behavior drift detectors (Mythos blog adaptation) ===
	// "Spotting contradictions between code comments and actual behavior"
	// was Mythos's strongest signal. Five narrow per-function detectors
	// here; all advisory (heuristic by nature — comments rot independently
	// of code, and the regex shape can't perfectly recognize every guard).
	{
		id: "comment_claims_limit_no_guard",
		phase: "post",
		name: "Comment Claims Limit With No Guard",
		description:
			'Detects functions whose comment says "max N" / "at most N" / "limited to N" but whose body has no `< N` / `<= N` guard for that number.',
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The comment promises a numeric limit but no guard in the body enforces it. Either remove the limit claim from the comment (if no limit is actually enforced) or add the missing `if (n > N) ...` / `slice(0, N)` / `Math.min(n, N)` guard so the comment and code agree.",
		fn: checkCommentClaimsLimitNoGuard,
		resultsPropName: "commentClaimsLimitNoGuard",
	},
	{
		id: "comment_claims_null_throws_instead",
		phase: "post",
		name: "Comment Claims Null Return But Body Throws",
		description:
			'Detects functions whose comment says "returns null on failure" / "may return undefined" but whose body contains an unhandled `throw`.',
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The comment promises null/undefined on failure but the body throws. Either wrap the failure path in try/catch and return null, or rewrite the comment to reflect that the function throws. Cold callers will write `if (result === null)` and miss the exception.",
		fn: checkCommentClaimsNullThrowsInstead,
		resultsPropName: "commentClaimsNullThrowsInstead",
	},
	{
		id: "comment_claims_validation_missing",
		phase: "post",
		name: "Comment Claims Validation But No Check Present",
		description:
			'Detects functions whose comment says "validates X" / "sanitizes Y" / "escapes Z" but whose body contains no conditional, regex, or encode call.',
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The comment claims validation/sanitization/escaping but the body has none — no conditional, regex test, or encode call. Either implement the validation or remove the claim. Cold callers (and downstream agents) will treat the output as safe.",
		fn: checkCommentClaimsValidationMissing,
		resultsPropName: "commentClaimsValidationMissing",
	},
	{
		id: "comment_claims_idempotent_mutates",
		phase: "post",
		name: "Comment Claims Idempotent But Body Mutates",
		description:
			'Detects functions whose comment says "idempotent" but whose body contains an unconditional mutation (++=, push, set, etc.) with no guard.',
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The comment promises idempotency but the body unconditionally mutates state. Either guard the mutation (`if (!set.has(x)) set.add(x)`) or remove the idempotency claim. Retry-safe callers will assume calling twice is safe and will be wrong.",
		fn: checkCommentClaimsIdempotentMutates,
		resultsPropName: "commentClaimsIdempotentMutates",
	},
	{
		id: "comment_claims_throws_doesnt",
		phase: "post",
		name: "Declared @throws Never Thrown",
		description:
			"Detects JSDoc @throws {ErrorX} declarations where the body never throws that error class.",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The function declares `@throws {ErrorX}` but never throws `new ErrorX(...)`. Either remove the declaration or add the missing throw. Documented exception contracts that don't match behavior produce useless catch sites downstream.",
		fn: checkCommentClaimsThrowsDoesnt,
		resultsPropName: "commentClaimsThrowsDoesnt",
	},
];
