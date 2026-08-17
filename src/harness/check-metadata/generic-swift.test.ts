// Content-lock test for GENERIC_SWIFT_META.
//
// generic-fragments.test.ts verifies only the CheckMeta shape. Its type checks
// accept an empty name or description, so a StringLiteral -> "" mutation in
// generic-swift.ts can survive. Keep this expectation independent of the
// implementation: a mutated metadata literal must produce a visible diff.

import { describe, expect, it } from "vitest";
import { GENERIC_SWIFT_META } from "./generic-swift.js";
import type { CheckMeta } from "./types.js";

const EXPECTED: Record<string, CheckMeta> = {
	swift_task_detached: {
		name: "Swift Task.detached",
		description:
			"Detects `Task.detached { ... }` — breaks structured concurrency; loses parent priority + actor.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_unhandled_task_error: {
		name: "Swift Unhandled Task Error",
		description:
			"Detects `try` inside `Task { ... }` without enclosing `do { } catch` — error is silently swallowed.",
		tier: 2,
		determinism: "heuristic",
	},
	swift_global_var_no_isolation: {
		name: "Swift Global var No Isolation",
		description:
			"Detects file-scope `var` without `@MainActor` / global-actor isolation — Swift 6 strict-concurrency violation.",
		tier: 2,
		determinism: "heuristic",
	},
	swift_self_in_escaping_closure: {
		name: "Swift self in Escaping Closure",
		description:
			"Detects `self.` inside `@escaping` closure without `[weak self]` / `[unowned self]` capture list — retain cycle risk.",
		tier: 2,
		determinism: "heuristic",
	},
	swift_dispatch_main_sync: {
		name: "Swift DispatchQueue.main.sync",
		description:
			"Detects `DispatchQueue.main.sync` — deadlocks the process when invoked while already on main.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_task_sleep_legacy: {
		name: "Swift Task.sleep Legacy",
		description:
			"Detects `Task.sleep(nanoseconds:)` — replaced by `Task.sleep(for:)` in Swift 5.7+ (SE-0329).",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_notification_observer_no_removal: {
		name: "Swift NotificationCenter Observer No Removal",
		description:
			"Detects `addObserver(...)` in a file with no matching `removeObserver` — block-based observers leak.",
		tier: 2,
		determinism: "heuristic",
	},
	swift_timer_no_invalidate: {
		name: "Swift Timer No Invalidate",
		description:
			"Detects `Timer.scheduledTimer(...)` without any `invalidate()` in the file — owner cannot be deallocated.",
		tier: 2,
		determinism: "heuristic",
	},
	swift_combine_no_store: {
		name: "Swift Combine No store(in:)",
		description:
			"Detects `.sink` / `.assign(to:on:)` without `.store(in: &cancellables)` — subscription cancels at end of scope.",
		tier: 2,
		determinism: "heuristic",
	},
	swift_weak_crypto: {
		name: "Swift Weak Crypto",
		description:
			"Detects MD5 / SHA-1 / DES via CommonCrypto / CryptoKit `Insecure.*` / `kCCAlgorithmDES`.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_http_url_literal: {
		name: "Swift http:// URL Literal",
		description:
			'Detects `URL(string: "http://...")` for non-localhost / non-RFC1918 hosts — defeats ATS and leaks cleartext.',
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_userdefaults_for_secret: {
		name: "Swift UserDefaults for Secret",
		description:
			"Detects `UserDefaults.*.set(...)` / `@AppStorage` with sensitive key names (password/token/apiKey/...) — UserDefaults is plaintext.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_ats_arbitrary_loads: {
		name: "Swift ATS Arbitrary Loads",
		description:
			"Detects `NSAllowsArbitraryLoads` / `NSExceptionAllowsInsecureHTTPLoads` set to true in Info.plist — globally disables ATS.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_empty_catch: {
		name: "Swift Empty catch",
		description:
			"Detects `catch { }` (or `catch let _ { }`) with no body — silently swallows the error.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_try_question_discarded: {
		name: "Swift try? Result Discarded",
		description:
			"Detects `try?` at statement position with both error AND optional value discarded — almost always a mistake.",
		tier: 2,
		determinism: "heuristic",
	},
	swift_nsurl_legacy_bridge: {
		name: "Swift NSURL Legacy Bridge",
		description:
			"Detects `NSURL(string:)` / `NSURLRequest(url:)` / `NSURLComponents()` — should use Swift-native `URL` / `URLRequest`.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_fatalerror_in_guard: {
		name: "Swift fatalError in guard",
		description:
			"Detects `guard ... else { fatalError(...) }` — force-unwrap dressed up with extra ceremony.",
		tier: 2,
		determinism: "heuristic",
	},
	swift_print_in_view_body: {
		name: "Swift print() in SwiftUI body",
		description:
			"Detects `print(...)` inside SwiftUI `var body` — re-evaluated on every state change, drowns the log.",
		tier: 2,
		determinism: "heuristic",
	},
	swift_filter_count: {
		name: "Swift .filter{}.count",
		description:
			"Detects `.filter { ... }.count` — allocates a throwaway array just to count; use `.count(where:)`.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_file_id_over_file_path: {
		name: "Swift #fileID over #file/#filePath",
		description:
			"Detects `#file` / `#filePath` — both leak the developer's absolute path into the binary. Use `#fileID`.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	swift_abbreviations: {
		name: "Swift Abbreviations",
		description:
			"Detects non-standard abbreviations (`btn`, `lbl`, `mgr`, `cfg`, ...) in Swift identifiers. Apple ADG: avoid abbreviations.",
		tier: 2,
		determinism: "heuristic",
	},
};

describe("GENERIC_SWIFT_META content", () => {
	it("preserves every name, description, tier, and determinism value", () => {
		expect(GENERIC_SWIFT_META).toEqual(EXPECTED);
	});
});
