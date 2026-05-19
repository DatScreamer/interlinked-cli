// Batch 1 agent-laziness warning entries: detectors for the tells an LLM
// leaves when it gives up early — placeholder prose, not-implemented stubs,
// dead literal branches, file-wide suppressions, type-system escape hatches,
// NODE_ENV branching, and unguarded async fan-out. Extracted from
// entries-warnings.ts — re-exported there as part of WARNING_ENTRIES.

import {
	checkAgentThumbprintProse,
	checkDeadBranchLiteral,
	checkDoubleCastUnknown,
	checkFetchWithoutTimeout,
	checkFileLevelSuppression,
	checkNodeEnvBranchInProd,
	checkStubNotImplementedThrow,
	checkSyncIoOnHotPath,
	checkTypeSmuggling,
	checkUnboundedPromiseAll,
	checkUnionWidenedWithString,
	checkUntestableTimeInSource,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const AGENT_LAZINESS_ENTRIES: CheckRegistration[] = [
	// ========================================================================
	// Batch 1: agent-laziness checks (11 entries)
	// ========================================================================
	{
		id: "agent_thumbprint_prose",
		phase: "post",
		name: "Agent Thumbprint Prose",
		description:
			"Detects literal phrases LLMs use when giving up — \"in a real implementation\", \"for now\", \"placeholder\", \"TODO: actually implement\" — left in source comments instead of finishing the work.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This phrase is a tell that the implementation was left incomplete. Either finish the code so the comment is no longer needed, or replace the comment with a tracked issue link (e.g. // TODO(TICKET-123): wire up real auth) so the gap is visible to reviewers and maintainers.",
		fn: checkAgentThumbprintProse,
		resultsPropName: "agentThumbprintProse",
	},
	{
		id: "stub_not_implemented_throw",
		phase: "post",
		name: "Stub Not-Implemented Throw",
		description:
			"Detects `throw new Error(\"not implemented\")` and variants in non-test source — placeholder stubs left after the agent ran out of context.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Either implement the function or delete the stub. If the stub is intentional (abstract base class skeleton), throw a typed error with a meaningful message: `throw new MethodMustBeImplementedError(\"Subclass FooBase must implement bar()\")`.",
		fn: checkStubNotImplementedThrow,
		resultsPropName: "stubNotImplementedThrow",
	},
	{
		id: "dead_branch_literal",
		phase: "post",
		name: "Dead Branch Literal",
		description:
			"Detects `if (true)` / `if (false)` / `else if (true)` — debugger artifacts that bypass real control flow. Skips `while (true)` (legit event-loop idiom).",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace the literal with a real condition or remove the dead branch entirely. `if (true)` keeps the body running unconditionally and silently disables whatever was on the other side; `if (false)` is unreachable code masquerading as a branch.",
		fn: checkDeadBranchLiteral,
		resultsPropName: "deadBranchLiteral",
	},
	{
		id: "file_level_suppression",
		phase: "post",
		name: "File-Level Suppression",
		description:
			"Detects file-wide suppression directives (ts-nocheck, eslint-disable with no rule list, biome-ignore-all, pylint disable=all) — they hide every issue in the file, not just the one that prompted the suppression.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"File-wide suppressions are invisible at every site of the file — a cold reader sees no warnings even though the checker is silenced. Replace with line-level directives that name the specific rule and include a justification: `// @ts-expect-error -- TICKET-123: third-party types are wrong here`.",
		fn: checkFileLevelSuppression,
		resultsPropName: "fileLevelSuppression",
	},
	{
		id: "untestable_time_in_source",
		phase: "post",
		name: "Untestable Time / Nondeterminism in Source",
		description:
			"Detects inline Date.now / new Date() / Math.random / crypto.randomUUID / performance.now in non-test source. The #1 cause of \"passes locally, flakes in CI.\" Skips clock/random/uuid injection-point files.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Inject a clock or RNG instead of calling the global directly. Pattern: take `clock: () => number` (or `randomUUID: () => string`) as a constructor / function parameter with a default of `Date.now` / `crypto.randomUUID`. Tests pass a deterministic fake; production gets the real one. Without this, every code path that touches the call becomes flaky to test.",
		fn: checkUntestableTimeInSource,
		resultsPropName: "untestableTimeInSource",
	},
	{
		id: "double_cast_unknown",
		phase: "post",
		name: "Double-Cast via Unknown",
		description:
			"Detects `as unknown as Foo` — agents reach for this when a single `as` won't satisfy TypeScript. Lying to the type system through a wider escape hatch.",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`as unknown as Foo` bypasses TypeScript entirely. If the value really might be Foo, validate it with a schema parser (zod, valibot, ajv) at the boundary so the runtime check matches the type assertion. If it's truly unsafe but unavoidable, isolate the cast in a single named helper with a comment explaining the invariant the cast relies on.",
		fn: checkDoubleCastUnknown,
		resultsPropName: "doubleCastUnknown",
	},
	{
		id: "type_smuggling",
		phase: "post",
		name: "Type-Smuggling Cast",
		description:
			"Detects TypeScript `as T` casts whose source expression's static type has no structural overlap with `T` — the cast lies, instead of narrowing or widening. Uses the TypeScript compiler API for assignability checks in both directions; `as unknown`/`as any`/`as const` are exempt.",
		tier: 3,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`as T` is a lie when the source type and `T` share no structural relationship — TypeScript won't catch the bug at runtime. Either (a) validate the value with a schema parser (zod/valibot/ajv) at the boundary so the runtime shape matches the declared type, (b) narrow with a type guard (`if ('id' in value && typeof value.id === 'number') ...`), or (c) restructure so the source type already includes `T` in a union. If you genuinely need a wide cast as an escape hatch, use `as unknown as T` and document the invariant — but prefer validation first.",
		fn: checkTypeSmuggling,
		resultsPropName: "typeSmuggling",
		content_keywords: [" as "],
	},
	{
		id: "union_widened_with_string",
		phase: "post",
		name: "Union Widened With Bare String",
		description:
			"Detects `type X = \"a\" | \"b\" | string` patterns — TypeScript narrows the result back to `string`, defeating the literal alternatives.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`\"a\" | \"b\" | string` collapses to `string` — the literals provide no autocomplete or exhaustiveness benefit. If you genuinely need open-ended values, use the branded-string pattern: `type X = \"a\" | \"b\" | (string & {})`. If the values are known, drop the `| string` and use the literal union alone.",
		fn: checkUnionWidenedWithString,
		resultsPropName: "unionWidenedWithString",
	},
	{
		id: "nodeenv_branch_in_prod",
		phase: "post",
		name: "NODE_ENV Branch in Production",
		description:
			"Detects `process.env.NODE_ENV === \"test\"` (or development/staging/local) inside non-test, non-config source — production behavior branched on test mode.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Production code should not branch on NODE_ENV. Either inject the dependency the test wants to fake (a config object, a mock client) or move the branch to a setup module that's only imported in non-production entry points. Otherwise tests and production silently disagree.",
		fn: checkNodeEnvBranchInProd,
		resultsPropName: "nodeenvBranchInProd",
	},
	{
		id: "fetch_without_timeout",
		phase: "post",
		name: "Fetch / Axios Without Timeout",
		description:
			"Detects fetch() and axios.{get,post,...}() calls without `signal:` / `timeout:` / AbortController in their options window.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Without a timeout or abort signal, a slow upstream leaks request handles and ties up the calling code indefinitely. Pass `AbortSignal.timeout(ms)` (Node 18+ / browsers) or an AbortController.signal: `await fetch(url, { signal: AbortSignal.timeout(5000) });`. For axios, use `{ timeout: 5000 }`.",
		fn: checkFetchWithoutTimeout,
		resultsPropName: "fetchWithoutTimeout",
	},
	{
		id: "unbounded_promise_all",
		phase: "post",
		name: "Promise.all on Unbounded Array",
		description:
			"Detects `Promise.all(<ident>.map(asyncFn))` patterns where the source array isn't visibly bounded — fans out N parallel requests for an N-sized input.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`Promise.all(items.map(fn))` runs every item concurrently — with 10K rows you get 10K parallel sockets, exhausting connection pools and triggering rate limits. Use a concurrency-limited helper: `await pMap(items, fn, { concurrency: 10 })` or `p-limit`. Reserve raw Promise.all for short, hand-authored fixed lists.",
		fn: checkUnboundedPromiseAll,
		resultsPropName: "unboundedPromiseAll",
	},
	{
		id: "sync_io_on_hot_path",
		phase: "post",
		name: "Synchronous I/O on Hot Path",
		description:
			"Detects *Sync (readFileSync / execSync / spawnSync / statSync / etc.) inside HTTP handler / route / middleware files or functions whose names imply request handling.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Synchronous I/O blocks the event loop — every concurrent request waits behind the disk / subprocess. Replace with the promisified API: `await readFile(path)`, `await new Promise(r => exec(cmd, r))` / execa, etc. Keep *Sync calls confined to startup, CLIs, and one-shot scripts where blocking the single thread is fine.",
		fn: checkSyncIoOnHotPath,
		resultsPropName: "syncIoOnHotPath",
	},
];
