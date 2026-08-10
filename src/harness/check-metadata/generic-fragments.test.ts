// Companion test for the per-family GENERIC_CHECK_META fragments.
//
// generic.ts was decomposed from one 1250-line literal into sibling
// generic-<family>.ts fragments, composed back together via spread. This
// file pins, per fragment: (1) non-empty record, (2) every entry has the
// CheckMeta shape, (3) the exact key set (so an entry can't silently drift
// between fragments). It then pins the composition invariants the spread
// depends on: fragment key sets are pairwise disjoint (a duplicate key would
// be silently dropped), and the composed GENERIC_CHECK_META equals the union
// of all fragments with the expected total of 195 keys.

import { describe, expect, it } from "vitest";
import { GENERIC_CHECK_META } from "./generic.js";
import { GENERIC_AGENT_LAZINESS_META } from "./generic-agent-laziness.js";
import { GENERIC_API_SHAPE_META } from "./generic-api-shape.js";
import { GENERIC_C_META } from "./generic-c.js";
import { GENERIC_CORE_JS_META } from "./generic-core-js.js";
import { GENERIC_CROSS_FILE_META } from "./generic-cross-file.js";
import { GENERIC_DEMO_DATA_META } from "./generic-demo-data.js";
import { GENERIC_ENDPOINT_META } from "./generic-endpoint.js";
import { GENERIC_ITERATION_SAFETY_META } from "./generic-iteration-safety.js";
import { GENERIC_REACT_WARNINGS_META } from "./generic-react-warnings.js";
import { GENERIC_SWIFT_META } from "./generic-swift.js";
import { GENERIC_TEST_HYGIENE_META } from "./generic-test-hygiene.js";
import { GENERIC_UBS_META } from "./generic-ubs.js";
import type { CheckMeta } from "./types.js";

// Expected exact key set per fragment. Editing a fragment without updating the
// matching list here (or vice-versa) fails the test — the guard against a key
// silently moving between fragments or disappearing.
const FRAGMENTS: Record<string, { meta: Record<string, CheckMeta>; keys: string[] }> = {
	"generic-api-shape": {
		meta: GENERIC_API_SHAPE_META,
		keys: [
			"complexity",
			"cognitive_complexity",
			"boolean_trap",
			"positional_optional_boolean",
			"many_optional_params",
			"same_typed_primitive_params",
			"comment_claims_limit_no_guard",
			"comment_claims_null_throws_instead",
			"comment_claims_validation_missing",
			"comment_claims_idempotent_mutates",
			"comment_claims_throws_doesnt",
		],
	},
	"generic-iteration-safety": {
		meta: GENERIC_ITERATION_SAFETY_META,
		keys: [
			"iterator_invalidation",
			"fresh_collection_key_lookup",
			"discriminated_union_exhaustiveness",
			"index_bounds_unchecked",
			"cleanup_skipped_on_early_exit",
			"tainted_to_privileged_sink",
			"await_state_toctou",
			"cleanup_reentrancy",
			"boundary_copy_no_revalidation",
		],
	},
	"generic-core-js": {
		meta: GENERIC_CORE_JS_META,
		keys: [
			"misused_promises",
			"floating_promises",
			"broad_object_types",
			"magic_literal_in_conditional",
			"nan_coercion_guard",
			"cjs_in_esm_module",
			"array_push_return_used",
			"array_iteratee_variadic_builtin",
			"write_without_mkdir",
			"homedir_write_escape",
			"duplicated_policy_constant",
			"type_predicate_drift",
			"snapshot_hygiene",
			"design_slop",
			"rust_unsafe_span",
			"suppression_block_span",
			"anonymous_registration",
			"payload_field_casing",
			"gitignored_written_config",
			"spec_path_ref",
			"promise_reject_non_error",
			"raw_control_bytes",
			"lossy_error_rethrow",
			"import_from_own_barrel",
			"error_dispatch_by_instanceof",
			"silent_promise_catch",
			"unvalidated_json_boundary",
			"dead_exports",
			"circular_imports",
			"untested_inverse_pair",
			"untested_idempotent",
			"lifecycle_cleanup",
			"default_export",
			"code_clones",
			"async_promise_executor",
			"self_import",
			"eval_usage",
			"inner_html",
			"nan_comparison",
			"unsafe_optional_chaining",
			"throw_literal",
			"dangerously_set_inner_html",
			"package_json_publish_invariants",
			"package_json_script_paths",
			"tsconfig_strictness",
			"disabled_tests",
			"snapshot_overuse",
			"test_importing_test",
			"target_blank_no_rel",
			"unjustified_cast",
			"process_env_outside_config",
			"top_level_side_effect",
			"unawaited_async_assertion",
			"timeout_unit_mismatch",
			"numeric_sort_without_comparator",
			"implicit_switch_fallthrough",
			"contradictory_nullness_chain",
			"json_stringify_error",
			"catch_rewrap_loses_cause",
			"resource_handle_leak",
			"jsdoc_param_drift",
		],
	},
	"generic-react-warnings": {
		meta: GENERIC_REACT_WARNINGS_META,
		keys: [
			"extraneous_deps",
			"non_null_assertion",
			"constant_condition",
			"number_precision_loss",
			"require_await",
			"json_parse_unsafe",
			"accumulating_spread",
			"excessive_use_state",
			"direct_dom_access",
			"inline_object_props",
			"async_event_handler",
			"nested_ternaries",
			"catch_and_log",
			"hardcoded_timeout",
			"sequential_awaits",
			"index_as_key",
			"missing_effect_cleanup",
			"over_mocking",
			"excessive_use_effect",
		],
	},
	"generic-c": {
		meta: GENERIC_C_META,
		keys: [
			"c_unsafe_functions",
			"c_include_guard",
			"c_strcmp_boolean_misuse",
			"c_unchecked_malloc",
			"c_sprintf_usage",
		],
	},
	"generic-ubs": {
		meta: GENERIC_UBS_META,
		keys: [
			"ubs_js_loose_equality",
			"ubs_float_equality",
			"ubs_java_optional_get",
			"ubs_rust_debug_assert_side_effect",
			"ubs_c_assert_side_effect",
			"ubs_python_assert_side_effect",
			"ubs_java_assert_side_effect",
			"ubs_rust_unchecked_cast_slice",
			"unaligned_reinterpret",
			"ubs_division_by_variable",
			"ubs_mutex_lock_unwrap",
			"ubs_subprocess_shell_true",
			"ubs_tls_verify_disabled",
			"ubs_py_none_equality",
			"ubs_weak_hash",
			"ubs_eval_input_tainted",
			"ubs_sql_string_concat",
			"sql_escape_hatch_non_literal",
			"ubs_python_mutable_default_arg",
			"ubs_tempfile_mktemp_race",
			"ubs_pickle_untrusted_load",
			"ubs_xml_external_entity",
			"ubs_os_system_tainted",
			"ubs_unsafe_format_string",
			"ubs_unchecked_redirect",
			"ubs_goroutine_no_waitgroup",
			"ubs_defer_in_loop",
			"ubs_string_concat_in_loop",
			"ubs_numeric_comparison_chain",
			"ubs_print_debug_leak",
			"ubs_hardcoded_localhost",
			"child_process_exec_user_input",
			"mixed_sync_async_file_api",
			"cookie_missing_security_flags",
			"logger_format_user_input",
			"ubs_magic_number_no_const",
			"ubs_large_function",
			"ubs_deeply_nested_callback",
			"ubs_time_format_locale_dep",
			"ubs_regex_in_loop_no_compile",
			"ubs_marshal_load",
			"ubs_shelve_open",
			"ubs_yaml_unsafe_load",
			"ubs_torch_unsafe_load",
			"ubs_pickle_wrapper_load",
			"ubs_aes_ecb_mode",
			"ubs_weak_random_security",
			"ubs_archive_extract_traversal",
			"ubs_python_assert_tautology",
			"ubs_node_create_cipher",
			"ubs_script_without_sri",
			"ubs_go_shell_injection",
			"ubs_github_actions_injection",
			"ubs_document_write",
			"ubs_outer_html_assignment",
			"ubs_insert_adjacent_html",
			"identical_conditional_branches",
		],
	},
	"generic-agent-laziness": {
		meta: GENERIC_AGENT_LAZINESS_META,
		keys: [
			"agent_thumbprint_prose",
			"stub_not_implemented_throw",
			"dead_branch_literal",
			"file_level_suppression",
			"untestable_time_in_source",
			"double_cast_unknown",
			"type_smuggling",
			"union_widened_with_string",
			"nodeenv_branch_in_prod",
			"fetch_without_timeout",
			"unbounded_promise_all",
			"sync_io_on_hot_path",
			"placeholder_runtime_constant",
		],
	},
	"generic-test-hygiene": {
		meta: GENERIC_TEST_HYGIENE_META,
		keys: [
			"duplicate_test_names",
			"real_io_in_tests",
			"test_nondeterminism",
			"hardcoded_timeout_in_tests",
			"test_missing_sut_import",
			"mocking_the_sut_self",
			"test_subprocess_default_timeout",
			"mock_only_test",
			"happy_path_only_test",
			"test_platform_conditional",
			"test_silent_dependency_skip",
			"procfs_probe_in_test",
		],
	},
	"generic-cross-file": {
		meta: GENERIC_CROSS_FILE_META,
		keys: ["empty_body_handler", "listener_pairing", "schema_type_drift", "migration_parity"],
	},
	"generic-demo-data": {
		meta: GENERIC_DEMO_DATA_META,
		keys: [
			"demo_data_unmarked",
			"silent_demo_fallback",
			"demo_runtime_missing_banner",
			"placeholder_data_in_ui",
			"placeholder_markdown_link",
			"manual_field_copy",
			"spec_dangling_anchor",
			"spec_numbering",
			"spec_count_claim",
			"spec_pitfall",
			"spec_claim_untagged",
			"spec_capacity_claim",
			"spec_table_sum",
			"spec_stage_order",
		],
	},
	"generic-endpoint": {
		meta: GENERIC_ENDPOINT_META,
		keys: [
			"endpoint_auth_missing",
			"endpoint_idor_shape",
			"endpoint_missing_tenant_filter",
			"endpoint_ssrf_shape",
			"endpoint_mass_assignment",
		],
	},
	"generic-swift": {
		meta: GENERIC_SWIFT_META,
		keys: [
			"swift_task_detached",
			"swift_unhandled_task_error",
			"swift_global_var_no_isolation",
			"swift_self_in_escaping_closure",
			"swift_dispatch_main_sync",
			"swift_task_sleep_legacy",
			"swift_notification_observer_no_removal",
			"swift_timer_no_invalidate",
			"swift_combine_no_store",
			"swift_weak_crypto",
			"swift_http_url_literal",
			"swift_userdefaults_for_secret",
			"swift_ats_arbitrary_loads",
			"swift_empty_catch",
			"swift_try_question_discarded",
			"swift_nsurl_legacy_bridge",
			"swift_fatalerror_in_guard",
			"swift_print_in_view_body",
			"swift_filter_count",
			"swift_file_id_over_file_path",
			"swift_abbreviations",
		],
	},
};

describe("GENERIC_CHECK_META fragments", () => {
	for (const [label, { meta, keys }] of Object.entries(FRAGMENTS)) {
		describe(label, () => {
			it("is a non-empty record", () => {
				expect(Object.keys(meta).length).toBeGreaterThan(0);
			});

			it("entries have the CheckMeta shape", () => {
				for (const [id, entry] of Object.entries(meta)) {
					expect(typeof entry.name, `${id}.name`).toBe("string");
					expect(typeof entry.description, `${id}.description`).toBe("string");
					expect([1, 2, 3], `${id}.tier`).toContain(entry.tier);
					expect(
						["fully_deterministic", "partially_deterministic", "heuristic"],
						`${id}.determinism`,
					).toContain(entry.determinism);
				}
			});

			it("has exactly the expected key set", () => {
				expect(Object.keys(meta).sort()).toEqual([...keys].sort());
			});
		});
	}
});

describe("GENERIC_CHECK_META composition", () => {
	const allFragments = Object.values(FRAGMENTS).map((f) => f.meta);

	it("fragment key sets are pairwise disjoint (no spread collision)", () => {
		const seen = new Map<string, string>();
		const collisions: string[] = [];
		for (const [label, { meta }] of Object.entries(FRAGMENTS)) {
			for (const key of Object.keys(meta)) {
				const prior = seen.get(key);
				if (prior) collisions.push(`${key} (in ${prior} and ${label})`);
				else seen.set(key, label);
			}
		}
		expect(collisions).toEqual([]);
	});

	it("composed record equals the union of all fragments", () => {
		const union: Record<string, CheckMeta> = {};
		for (const frag of allFragments) Object.assign(union, frag);
		expect(Object.keys(GENERIC_CHECK_META).sort()).toEqual(Object.keys(union).sort());
		for (const [id, entry] of Object.entries(GENERIC_CHECK_META)) {
			expect(union[id], id).toEqual(entry);
		}
	});

	it("preserves the full 231-key total", () => {
		const fragmentKeyTotal = allFragments.reduce((n, frag) => n + Object.keys(frag).length, 0);
		// 217 + cognitive_complexity (2026-07-24) + 8 Bun-regression detector pack
		// (assert-erasure ×3, reinterpret ×2, placeholder-const, unsafe-span ×2, 2026-07-20)
		// + raw_control_bytes (2026-07-25) + procfs_probe_in_test (2026-07-31)
		// + type_predicate_drift (2026-08-09) + homedir_write_escape (2026-08-10).
		expect(Object.keys(GENERIC_CHECK_META).length).toBe(231);
		// Sum-of-parts == whole confirms no key was dropped by the spread.
		expect(fragmentKeyTotal).toBe(231);
	});
});
