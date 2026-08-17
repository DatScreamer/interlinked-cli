// Swift/iOS advisory-skip ids — extracted from advisory.ts (2026-08-17) when
// the skip-policy file hit the 500-line cap ahead of the Plan 25 lanes 6-8
// additions (dynamic_code_execution, builtin_prototype_mutation,
// float_equality_comparison, test_contract_annotation,
// unvalidated_input_boundary). Same pattern as tool-ids.ts: the id table is a
// separate concern from the demotion policy; advisory.ts imports this array
// and spreads it back into DEFAULT_ADVISORY_SKIPS.

/** Public API — consumed by `advisory.ts`. Per-id rationale (heuristic
 *  Swift/iOS detectors, all advisory pending cross-repo FP calibration):
 *
 *  - swift_unhandled_task_error: scope-tracked across up to 30 lines of a
 *    Task body — heuristic on what counts as the "task body" boundary. Real
 *    bugs are clearly TPs; closures-returning-Task patterns may FP.
 *  - swift_global_var_no_isolation: file-scope brace-depth tracking; can FP
 *    on `var` inside `extension Module { }` and similar. Swift 6 strict-
 *    concurrency mode catches the same thing at compile-time when enabled —
 *    this check is the bridge for codebases still on Swift 5 default mode.
 *  - swift_self_in_escaping_closure: 20-line lookahead from `@escaping`;
 *    misses captures further down and may FP on uses that legitimately
 *    don't escape (e.g. the closure runs synchronously before return).
 *  - swift_notification_observer_no_removal /
 *    swift_timer_no_invalidate / swift_combine_no_store: file-scope
 *    absence-of-pairing heuristics. FP when the removal/invalidate/store
 *    lives in a sibling file (rare but real); swift_combine_no_store also
 *    FPs on `assign(to: &$published)`, whose `to:` param self-manages.
 *  - swift_try_question_discarded: statement-position heuristic. Misses
 *    `try?` inside conditionals split across lines; FPs on intentional
 *    fire-and-forget uses.
 *  - swift_fatalerror_in_guard: a taste call — `guard let x = … else {
 *    fatalError() }` is a force-unwrap with a better message. Advisory
 *    because the message IS sometimes load-bearing for crash triage.
 *  - swift_print_in_view_body: body-scope `print()` via brace counting. FPs
 *    on `let _ = { print(); return ... }()` patterns (rare).
 *  - swift_abbreviations: pure style enforcement — the most heuristic of the
 *    batch. Advisory by design; promotes only if a project opts in.
 */
export const SWIFT_ADVISORY_SKIP_IDS = [
	"swift_unhandled_task_error",
	"swift_global_var_no_isolation",
	"swift_self_in_escaping_closure",
	"swift_notification_observer_no_removal",
	"swift_timer_no_invalidate",
	"swift_combine_no_store",
	"swift_try_question_discarded",
	"swift_fatalerror_in_guard",
	"swift_print_in_view_body",
	"swift_abbreviations",
] as const;
