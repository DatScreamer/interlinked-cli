// Batch 2/5/8 warning entries: test-hygiene checks (duplicate names, real I/O
// in tests, nondeterminism, performative tests), cross-file structural checks
// (empty handlers, listener pairing, schema/type drift, migration parity), and
// demo-data leak detectors. Extracted from entries-warnings.ts — re-exported
// there as part of WARNING_ENTRIES.

import {
	checkDemoDataUnmarked,
	checkDemoRuntimeMissingBanner,
	checkDuplicateTestNames,
	checkEmptyBodyHandler,
	checkHardcodedTimeoutInTests,
	checkListenerPairing,
	checkManualFieldCopy,
	checkMigrationParity,
	checkMockingTheSutSelf,
	checkPlaceholderDataInUi,
	checkRealIoInTests,
	checkSchemaTypeDrift,
	checkSilentDemoFallback,
	checkTestMissingSutImport,
	checkTestNondeterminism,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const TEST_AND_DEMO_ENTRIES: CheckRegistration[] = [
	// ========================================================================
	// Batch 2: test-hygiene checks (6 entries)
	// ========================================================================
	{
		id: "duplicate_test_names",
		phase: "post",
		name: "Duplicate Test Names",
		description:
			"Detects two `it()` / `test()` / `specify()` blocks with identical name strings within the same file — copy-paste-then-edit-half-of-it bug class.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Two test blocks share the same name. Either the second is a stale copy that should be deleted, or the assertions diverged and one of them needs a more specific name describing what makes it different. Reporters list both runs under the same name, so a regression in either one reads as ambiguous.",
		fn: checkDuplicateTestNames,
		resultsPropName: "duplicateTestNames",
	},
	{
		id: "real_io_in_tests",
		phase: "post",
		name: "Real Network / Filesystem in Tests",
		description:
			"Detects fetch / axios / http.request to a non-loopback URL or *Sync writes to non-tmp paths inside test files.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Tests that hit the real network or real filesystem are flaky and slow. Mock the network with msw / nock / fetch-mock, and write only to os.tmpdir() / __fixtures__ / a memfs mock. Loopback (localhost / 127.0.0.1) is allowlisted for in-process test servers.",
		fn: checkRealIoInTests,
		resultsPropName: "realIoInTests",
	},
	{
		id: "test_nondeterminism",
		phase: "post",
		name: "Test Nondeterminism",
		description:
			"Detects Date.now / new Date() / Math.random / crypto.randomUUID / performance.now in test bodies without vi.useFakeTimers / equivalent mocking.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Tests that read the real clock / RNG flake under any timing or seed change. Replace Date.now / new Date() with vi.setSystemTime / a stubbed clock, and Math.random / crypto.randomUUID with a seeded RNG. If the file uses vi.useFakeTimers() at the top level, the check is suppressed for the whole file.",
		fn: checkTestNondeterminism,
		resultsPropName: "testNondeterminism",
	},
	{
		id: "hardcoded_timeout_in_tests",
		phase: "post",
		name: "Hardcoded Timeout in Tests",
		description:
			"Detects `setTimeout(_, NNNN)` / `setImmediate(_, NNNN)` waits with non-zero literal millisecond delays inside test bodies — \"I gave up debugging the timing condition\" tell.",
		tier: 2,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A literal millisecond wait is almost always wrong: too short and it flakes, too long and CI gets slow. Use `vi.waitFor(predicate)` / `await waitForElementToBeRemoved(...)` / poll a deterministic predicate. `setTimeout(_, 0)` is allowlisted because it's a microtask flush, not a wait.",
		fn: checkHardcodedTimeoutInTests,
		resultsPropName: "hardcodedTimeoutInTests",
	},
	{
		id: "test_missing_sut_import",
		phase: "post",
		name: "Test Missing SUT Import",
		description:
			"Detects test files (`foo.test.ts`) that don't import their SUT (`./foo` / `../foo`). Strong signal the test is performative — not actually exercising what its name claims.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`foo.test.ts` should import `./foo` (or a parent-dir variant) so that the test exercises real code from the SUT. If the test is testing a different file, rename it (e.g., `something-else.test.ts`); if the SUT lives elsewhere, fix the import path. As written, the test claims to cover code it doesn't touch.",
		fn: checkTestMissingSutImport,
		resultsPropName: "testMissingSutImport",
	},
	{
		id: "mocking_the_sut_self",
		phase: "post",
		name: "Mocking the SUT in Its Own Test",
		description:
			"Detects `vi.mock(\"./foo\")` / `jest.mock(\"./foo\")` inside `foo.test.ts` where the relative path resolves to the SUT itself.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A test that mocks its own SUT is testing the mock, not the code. Either remove the `vi.mock(./foo)` and let the real implementation run, or rename the test file (e.g., `foo-integration.test.ts`) so it's clearly testing the contract some other consumer has with `./foo`. Mocking `./foo` inside `foo.test.ts` is almost always the agent silencing a failing test rather than fixing it.",
		fn: checkMockingTheSutSelf,
		resultsPropName: "mockingTheSutSelf",
	},
	// ========================================================================
	// Batch 5: cross-file (4 entries; new-export orphan deferred)
	// ========================================================================
	{
		id: "empty_body_handler",
		phase: "post",
		name: "Empty-Body Handler",
		description:
			"Detects functions whose name implies request handling (handle*, route*, on[A-Z]*, HTTP-verb-named) with empty bodies, single `return;`, or only a console.log / logger call.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The function declares an API surface that does nothing. Either implement the body, throw a typed `MethodNotImplementedError(\"<name>\")` so callers fail fast, or rename the function so it doesn't claim to handle work it doesn't.",
		fn: checkEmptyBodyHandler,
		resultsPropName: "emptyBodyHandler",
	},
	{
		id: "listener_pairing",
		phase: "post",
		name: "Listener Pairing (Generalized)",
		description:
			"Detects addEventListener / process.on / emitter.on calls without a paired removeEventListener / off / removeListener anywhere in the same file.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Listeners outlive the registering scope when nothing removes them. Store the handler in a variable and pair the registration with the matching off / removeListener / removeEventListener in a teardown path (cleanup function, dispose, signal abort handler).",
		fn: checkListenerPairing,
		resultsPropName: "listenerPairing",
	},
	{
		id: "schema_type_drift",
		phase: "post",
		name: "Schema ↔ Type Drift",
		description:
			"Detects same-file Zod / valibot / yup schemas paired with TS interfaces / type aliases whose property sets diverge.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The runtime validator and the static type are supposed to agree about the shape — when they drift, callers see one truth and the runtime enforces a different one. Derive one from the other: `type User = z.infer<typeof UserSchema>` (Zod's recommended pattern) so the two cannot drift.",
		fn: checkSchemaTypeDrift,
		resultsPropName: "schemaTypeDrift",
	},
	{
		id: "migration_parity",
		phase: "post",
		name: "Migration Parity",
		description:
			"Detects `*_up.sql` files in migration directories without a paired `*_down.sql` — every up should be reversible.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Every migration should be reversible. Add the matching `_down.sql` (or a stub one with a TODO documenting why it's not safe to revert in this case). Without it, a botched deploy can't roll back without manual surgery.",
		fn: checkMigrationParity,
		resultsPropName: "migrationParity",
	},
	// ========================================================================
	// Batch 8: demo-data (3 entries)
	// ========================================================================
	{
		id: "demo_data_unmarked",
		phase: "post",
		name: "Unmarked Demo Data",
		description:
			"Detects fake/test data signatures (test emails @example.com, Stripe test cards, lorem ipsum, sentinel UUIDs, faker imports, mock/fake/sample identifier prefixes) that lack a `// @demo-data: <reason>` directive.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Either remove the demo data and wire up the real source, or mark it explicitly with `// @demo-data: <reason>` directly above so cold readers (and the rendered UI) see that the value isn't real. For data that flows into a chart / list rendered to users, prefer wrapping with `demoData(\"<key>\", value, { reason })` from the vendored demo-runtime so the page mounts a banner.",
		fn: checkDemoDataUnmarked,
		resultsPropName: "demoDataUnmarked",
	},
	{
		id: "silent_demo_fallback",
		phase: "post",
		name: "Silent Demo Fallback",
		description:
			"Detects `try { real API call } catch { return [literal data] }` patterns — the worst form of demo-data leak because it silently substitutes fake data when the upstream is unavailable.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A catch clause that returns hardcoded data hides upstream failures from users — they see plausible results that aren't real. Either re-throw the error so the caller can show a real error state, return a typed `Result<Error, T>` so the UI can react, or wrap the literal in `demoData()` so the demo banner mounts when the fallback path runs.",
		fn: checkSilentDemoFallback,
		resultsPropName: "silentDemoFallback",
	},
	{
		id: "demo_runtime_missing_banner",
		phase: "post",
		name: "Demo Runtime Without Banner",
		description:
			"Detects root-layout files (app/layout.tsx, src/main.tsx, etc.) that import from `interlinked-cli/demo-runtime` (or a vendored sibling) but do not render <DemoBanner />. Without the banner, users see no signal that the page contains demo data.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The vendored demo-runtime expects `<DemoBanner />` to be mounted in the root layout so any `demoData()` value rendered in the page lifecycle triggers a visible banner. Add `<DemoBanner />` somewhere inside the root `<body>` (or its equivalent) so the runtime can announce when the user is looking at fake data.",
		fn: checkDemoRuntimeMissingBanner,
		resultsPropName: "demoRuntimeMissingBanner",
	},
	{
		id: "placeholder_data_in_ui",
		phase: "post",
		name: "Placeholder Data in UI",
		description:
			"Detects placeholder/mock/fake data rendered into a user-facing UI file (.tsx/.jsx/.vue/.svelte/.astro/.html) — hardcoded numbers a comment marks as fake, mock/fake/dummy-named values, lorem ipsum copy, placeholder image hosts, and placeholder-shaped numbers (1111, 123456). Suppressed when the rendered UI carries a visible 'sample data' disclaimer.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A user will read this value as a real production figure. Fix it one of two ways: (1) wire it to real data — fetch from the API, pass real props, or read from the store; or (2) if the placeholder must stay (early prototype, pending integration), make its status unmistakable IN THE RENDERED UI — a visible 'Sample data' badge, a banner, or muted styling with an explicit label — so no human mistakes it for production. A code comment is not enough; the disclaimer has to be on screen. For values that flow into a chart or stat, prefer wrapping with `demoData(\"<key>\", value, { reason })` from the vendored demo-runtime so the page mounts a banner automatically.",
		fn: checkPlaceholderDataInUi,
		resultsPropName: "placeholderDataInUi",
	},
	{
		id: "manual_field_copy",
		phase: "post",
		name: "Manual Field Copy",
		description:
			"Detects a run of 5+ consecutive field copies target.k = source.k (matching key, same target + source objects) — hand-copying one object's fields onto another silently skips any field later added to the source.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Hand-copying fields object-to-object (target.k = source.k, repeated) silently skips any field later added to the source — the bug class behind a builder that computes a field its caller forgets to forward. Use object spread ({ ...source }) or Object.assign(target, source) so the field set stays in sync. If the subset is deliberate, leave a comment saying so.",
		fn: checkManualFieldCopy,
		resultsPropName: "manualFieldCopy",
	},
];
