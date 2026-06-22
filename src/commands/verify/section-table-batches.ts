// ===========================================
// Batch + tsconfig + endpoint-security sections
// ===========================================
// Fragment of the declarative section table in `./section-table.ts`.
// Covers the agent-laziness (Batch 1), test-hygiene (Batch 2), cross-file
// (Batch 5), and demo-data (Batch 8) packs, the tsconfig-strictness section,
// and the Phase B endpoint-security pack. Composed — in order — by
// `./section-table.ts`.

import type { SectionSpec } from "./section-table-types.js";

/** Batch 1/2/5/8 + tsconfig + endpoint-security sections (composed last). */
export const batchSections: readonly SectionSpec[] = [
	// === Batch 1: agent-laziness ===
	{
		label: "agent thumbprint prose",
		key: "agentThumbprintProse",
		noun: "agent-thumbprint phrases in source comments (\"for now\", \"in a real implementation\", placeholder narratives)",
		passLabel: "no agent-thumbprint phrases",
		color: "33",
	},
	{
		label: "stub not-implemented throw",
		key: "stubNotImplementedThrow",
		noun: "throw new Error(\"not implemented\" / \"TODO\" / \"stub\") in non-test source",
		passLabel: "no not-implemented stubs",
		color: "33",
	},
	{
		label: "dead branch literal",
		key: "deadBranchLiteral",
		noun: "if (true) / if (false) / else if (true) literal branch conditions",
		passLabel: "no dead branch literals",
		color: "33",
	},
	{
		label: "file-level suppression",
		key: "fileLevelSuppression",
		noun: "ts-nocheck / eslint-disable / biome-ignore-all directives at file head",
		passLabel: "no file-level suppression directives",
		color: "33",
	},
	{
		label: "untestable nondeterminism",
		key: "untestableTimeInSource",
		noun: "inline Date.now / new Date() / Math.random / crypto.randomUUID / performance.now in non-test source",
		passLabel: "no untestable nondeterminism",
		color: "33",
	},
	{
		label: "double-cast via unknown",
		key: "doubleCastUnknown",
		noun: "`as unknown as Foo` double-cast escape hatches",
		passLabel: "no double-cast escape hatches",
		color: "33",
	},
	{
		label: "type smuggling",
		key: "typeSmuggling",
		noun: "`as T` casts where source and target types have no structural overlap",
		passLabel: "no type-smuggling casts",
		color: "33",
	},
	{
		label: "union widened with string",
		key: "unionWidenedWithString",
		noun: "string-literal unions widened by a bare `string` (the literals are erased)",
		passLabel: "no string-widened unions",
		color: "33",
	},
	{
		label: "NODE_ENV branch in prod",
		key: "nodeenvBranchInProd",
		noun: "process.env.NODE_ENV comparisons inside production source",
		passLabel: "no NODE_ENV branches in production",
		color: "33",
	},
	{
		label: "fetch without timeout",
		key: "fetchWithoutTimeout",
		noun: "fetch / axios calls without signal: / timeout: / AbortController",
		passLabel: "all network calls have a timeout or abort signal",
		color: "33",
	},
	{
		label: "unbounded Promise.all",
		key: "unboundedPromiseAll",
		noun: "Promise.all(<ident>.map(...)) on unbounded source array",
		passLabel: "no unbounded fan-out",
		color: "33",
	},
	{
		label: "sync I/O on hot path",
		key: "syncIoOnHotPath",
		noun: "*Sync I/O calls inside HTTP handler / route / middleware files",
		passLabel: "no sync I/O on hot paths",
		color: "33",
	},
	// === Batch 2: test-hygiene ===
	{
		label: "duplicate test names",
		key: "duplicateTestNames",
		noun: "duplicate it() / test() / specify() name strings within a file",
		passLabel: "no duplicate test names",
		color: "33",
	},
	{
		label: "real network/FS in tests",
		key: "realIoInTests",
		noun: "real network or non-tmp filesystem calls inside test files",
		passLabel: "no real I/O in tests",
		color: "33",
	},
	{
		label: "test nondeterminism",
		key: "testNondeterminism",
		noun: "Date.now / Math.random / crypto.randomUUID in test bodies without fake-timers",
		passLabel: "no test nondeterminism",
		color: "33",
	},
	{
		label: "hardcoded timeout in tests",
		key: "hardcodedTimeoutInTests",
		noun: "setTimeout / setImmediate with literal ms delays inside test bodies",
		passLabel: "no hardcoded timeouts in tests",
		color: "33",
	},
	{
		label: "test missing SUT import",
		key: "testMissingSutImport",
		noun: "test files that don't import their SUT",
		passLabel: "all test files import their SUT",
		color: "33",
	},
	{
		label: "mocking the SUT self",
		key: "mockingTheSutSelf",
		noun: "vi.mock / jest.mock targeting the file under test from inside its own test",
		passLabel: "no SUT-self mocks",
		color: "31",
	},
	{
		label: "test subprocess without timeout",
		key: "testSubprocessDefaultTimeout",
		noun: "it() / test() spawning a slow subprocess (tsc / biome / npx / tsx / eslint / vitest / CLI) with no explicit timeout",
		passLabel: "no slow-subprocess tests without an explicit timeout",
		color: "33",
	},
	{
		label: "mock-only tests",
		key: "mockOnlyTest",
		skipId: "mock_only_test",
		noun: "it() / test() blocks asserting only mock-call interactions, never a value / output / state",
		passLabel: "no mock-only tests",
		color: "33",
	},
	{
		label: "happy-path-only test files",
		key: "happyPathOnlyTest",
		skipId: "happy_path_only_test",
		noun: "test files (3+ cases) that never assert a failure path",
		passLabel: "all test files exercise a failure path",
		color: "33",
	},
	{
		label: "introverted tests",
		key: "introvertedTest",
		skipId: "introverted_test",
		noun: "it() / test() blocks whose assertions never trace to a non-mocked system-under-test call",
		passLabel: "no introverted tests",
		color: "33",
	},
	// === Batch 5: cross-file ===
	{
		label: "empty-body handler",
		key: "emptyBodyHandler",
		noun: "handler-named functions with empty / no-op bodies",
		passLabel: "no empty-body handlers",
		color: "33",
	},
	{
		label: "listener pairing",
		key: "listenerPairing",
		noun: "addEventListener / process.on / emitter.on without paired cleanup elsewhere in the file",
		passLabel: "all listeners paired with cleanup",
		color: "33",
	},
	{
		label: "schema/type drift",
		key: "schemaTypeDrift",
		noun: "same-file Zod schema vs TS interface drift",
		passLabel: "schema and type agree",
		color: "33",
	},
	{
		label: "migration parity",
		key: "migrationParity",
		noun: "_up.sql migrations without paired _down.sql",
		passLabel: "every migration is reversible",
		color: "33",
	},
	// === Batch 8: demo-data ===
	{
		label: "unmarked demo data",
		key: "demoDataUnmarked",
		noun: "fake-data signatures without `// @demo-data:` directive",
		passLabel: "no unmarked demo data",
		color: "33",
	},
	{
		label: "silent demo fallback",
		key: "silentDemoFallback",
		noun: "try { real API } catch { return [literal] } patterns",
		passLabel: "no silent demo fallbacks",
		color: "31",
	},
	{
		label: "demo runtime banner",
		key: "demoRuntimeMissingBanner",
		noun: "root-layout files importing demo runtime without rendering DemoBanner",
		passLabel: "demo runtime banner mounted",
		color: "33",
	},
	{
		label: "placeholder data in UI",
		key: "placeholderDataInUi",
		noun: "placeholder/mock values rendered into a user-facing UI",
		passLabel: "no placeholder data in rendered UI",
		color: "33",
	},
	// === tsconfig strictness — surfaces on tsconfig*.json edits ===
	{
		label: "tsconfig strictness",
		key: "tsconfigStrictness",
		noun: "missing tsconfig strictness flags (noUncheckedIndexedAccess, exactOptionalPropertyTypes, etc.)",
		passLabel: "tsconfig has all required strictness flags",
		color: "33",
	},
	// === Phase B endpoint-security pack (2026-05) ===
	{
		label: "endpoint auth missing",
		key: "endpointAuthMissing",
		noun: "HTTP endpoints with no recognized auth middleware",
		passLabel: "every endpoint has an auth chain or is in the exempt list",
		color: "33",
	},
	{
		label: "endpoint IDOR shape",
		key: "endpointIdorShape",
		noun: "handlers using a path param as a DB key without an auth-context predicate",
		passLabel: "no IDOR-shape handlers",
		color: "33",
	},
	{
		label: "endpoint missing tenant filter",
		key: "endpointMissingTenantFilter",
		noun: "DB queries in a handler scope without a tenant column filter",
		passLabel: "every query filters by tenant",
		color: "33",
	},
	{
		label: "endpoint SSRF shape",
		key: "endpointSsrfShape",
		noun: "handlers fetching a URL-shaped value without an allow-list sanitizer",
		passLabel: "no unguarded URL-fetching handlers",
		color: "33",
	},
	{
		label: "endpoint mass assignment",
		key: "endpointMassAssignment",
		noun: "handlers spreading request body into a model without an allowlist",
		passLabel: "every body assignment is explicitly allowlisted or schema-validated",
		color: "33",
	},
];
