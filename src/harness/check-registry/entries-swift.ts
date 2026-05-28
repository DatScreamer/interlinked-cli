// Swift / iOS warning entries. All `post` phase, severity `warning`.
//
// The seven Apple ADG / memory-safety regexes (force_cast, force_try,
// force_unwrap, implicitly_unwrapped_optional, delegate_not_weak,
// legacy_random, legacy_hashvalue) ALREADY ship as declarative
// `inline_checks` entries in `language-profiles.ts::swift.inline_checks`
// — those run via `quality-checks/inline-language-checks.ts` and are NOT
// re-wired here to avoid double-reporting.
//
// This file wires the *other* Swift detector functions exported from
// `checks/swift.ts` that were previously orphaned (defined but never
// dispatched). They cover concurrency safety (Task.detached, unhandled
// task errors, Swift 6 global-var isolation), memory safety (self in
// escaping closures), performance (.filter{...}.count), source-leak
// privacy (#file → #fileID), and naming style (abbreviations).
//
// Plus the entries for the new Swift detectors landed alongside this
// rollout: dispatch-main-sync, task-sleep-legacy, notification-observer
// leak, timer-no-invalidate, Combine-no-store, weak-crypto, http-url
// literal, UserDefaults-for-secret, empty-catch, try?-discarded,
// NSURL legacy bridge, fatalError-in-guard, print-in-view-body.

import {
	checkSwiftAbbreviations,
	checkSwiftFileIdOverFilePath,
	checkSwiftFilterCount,
	checkSwiftGlobalVarNoIsolation,
	checkSwiftSelfInEscapingClosure,
	checkSwiftTaskDetached,
	checkSwiftUnhandledTaskError,
} from "../checks/swift.js";
import {
	checkSwiftDispatchMainSync,
	checkSwiftTaskSleepLegacy,
} from "../checks/swift-concurrency.js";
import {
	checkSwiftCombineNoStore,
	checkSwiftNotificationObserverNoRemoval,
	checkSwiftTimerNoInvalidate,
} from "../checks/swift-lifecycle.js";
import {
	checkSwiftEmptyCatch,
	checkSwiftFatalErrorInGuard,
	checkSwiftNsurlLegacyBridge,
	checkSwiftPrintInViewBody,
	checkSwiftTryQuestionDiscarded,
} from "../checks/swift-quality.js";
import {
	checkSwiftAtsArbitraryLoads,
	checkSwiftHttpUrlLiteral,
	checkSwiftUserDefaultsForSecret,
	checkSwiftWeakCrypto,
} from "../checks/swift-security.js";
import type { CheckRegistration } from "./types.js";

export const SWIFT_ENTRIES: CheckRegistration[] = [
	// === Concurrency safety ===
	{
		id: "swift_task_detached",
		phase: "post",
		name: "Swift Task.detached",
		description:
			"Detects `Task.detached { ... }` — almost always wrong; breaks structured concurrency.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `Task { ... }` (inherits priority + actor) or a `TaskGroup` for structured concurrency. `Task.detached` is reserved for the rare case where you genuinely need to drop the parent's actor and priority — and that case should be commented.",
		fn: checkSwiftTaskDetached,
		resultsPropName: "swiftTaskDetached",
		content_keywords: ["Task", "detached"],
	},
	{
		id: "swift_unhandled_task_error",
		phase: "post",
		name: "Swift Unhandled Task Error",
		description:
			"Detects `try` inside a `Task { ... }` body without an enclosing `do { } catch` — the error is silently swallowed and the task fails invisibly.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Wrap the `try` in a `do { } catch { ... }` inside the Task closure, or change `try` to `try?` if discarding the error is intentional. An unhandled throw inside an unstructured `Task { ... }` is invisible — the task just dies.",
		fn: checkSwiftUnhandledTaskError,
		resultsPropName: "swiftUnhandledTaskError",
		content_keywords: ["Task", "try"],
	},
	{
		id: "swift_global_var_no_isolation",
		phase: "post",
		name: "Swift Global var No Isolation",
		description:
			"Detects file-scope `var` declarations without `@MainActor` / global-actor isolation — Swift 6 strict-concurrency violation.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Isolate global mutable state to an actor: `@MainActor var counter = 0` or move it inside an `actor` type. In Swift 6, unisolated global `var` is a compile error; in Swift 5, it's a `@preconcurrency` warning. Immutable `let` is fine because there's no mutation to race on.",
		fn: checkSwiftGlobalVarNoIsolation,
		resultsPropName: "swiftGlobalVarNoIsolation",
		content_keywords: ["var "],
	},
	{
		id: "swift_self_in_escaping_closure",
		phase: "post",
		name: "Swift self in Escaping Closure",
		description:
			"Detects `self.` inside an `@escaping` closure body without a `[weak self]` / `[unowned self]` capture list — retain cycle risk.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add a capture list to break the retain cycle: `{ [weak self] ... in guard let self else { return } ... }`. An escaping closure that captures `self` strongly outlives the enclosing scope and keeps the owning object alive — classic leak. Use `[unowned self]` only when you can prove the closure cannot outlive `self`.",
		fn: checkSwiftSelfInEscapingClosure,
		resultsPropName: "swiftSelfInEscapingClosure",
		content_keywords: ["@escaping"],
	},
	{
		id: "swift_dispatch_main_sync",
		phase: "post",
		name: "Swift DispatchQueue.main.sync",
		description:
			"Detects `DispatchQueue.main.sync` — deadlocks the process if invoked while already on the main thread.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `DispatchQueue.main.async { ... }` for fire-and-forget main-thread work, or `await MainActor.run { ... }` in async contexts. `DispatchQueue.main.sync` from the main thread is an instant self-deadlock — Apple's threading guide calls this out explicitly.",
		fn: checkSwiftDispatchMainSync,
		resultsPropName: "swiftDispatchMainSync",
		content_keywords: ["DispatchQueue", "main", "sync"],
	},
	{
		id: "swift_task_sleep_legacy",
		phase: "post",
		name: "Swift Task.sleep Legacy",
		description:
			"Detects `Task.sleep(nanoseconds:)` — replaced by `Task.sleep(for:)` / `Task.sleep(until:clock:)` in Swift 5.7+.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `try await Task.sleep(for: .seconds(1))` (or `.milliseconds(...)` / `.nanoseconds(...)`) instead of `Task.sleep(nanoseconds:)`. The duration-based API is type-safe and the unit conversion no longer rots when someone reads `1_000_000_000` and forgets it's nanoseconds.",
		fn: checkSwiftTaskSleepLegacy,
		resultsPropName: "swiftTaskSleepLegacy",
		content_keywords: ["Task.sleep", "nanoseconds"],
	},

	// === Lifecycle / resource leaks ===
	{
		id: "swift_notification_observer_no_removal",
		phase: "post",
		name: "Swift NotificationCenter Observer No Removal",
		description:
			"Detects `NotificationCenter.*.addObserver(...)` in a class without a matching `removeObserver`. Block-based observers leak unless explicitly removed in `deinit`.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Remove the observer in `deinit` (or pair every `addObserver` with a `removeObserver` on a lifecycle boundary). Block-based `addObserver(forName:object:queue:using:)` returns an opaque token; storing it lets you `removeObserver` later. iOS 9+ removes selector-based observers automatically on dealloc — block-based ones still leak.",
		fn: checkSwiftNotificationObserverNoRemoval,
		resultsPropName: "swiftNotificationObserverNoRemoval",
		content_keywords: ["addObserver"],
	},
	{
		id: "swift_timer_no_invalidate",
		phase: "post",
		name: "Swift Timer No Invalidate",
		description:
			"Detects `Timer.scheduledTimer(...)` whose token is stored in a property but never `invalidate()`d — repeating timer leaks + retains its target.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Call `timer.invalidate()` in `deinit` (or when the timer is no longer needed) and set the property to `nil`. A `Timer.scheduledTimer` keeps a strong reference to its target via the run-loop; without `invalidate`, the owner is never deallocated.",
		fn: checkSwiftTimerNoInvalidate,
		resultsPropName: "swiftTimerNoInvalidate",
		content_keywords: ["Timer", "scheduledTimer"],
	},
	{
		id: "swift_combine_no_store",
		phase: "post",
		name: "Swift Combine No store(in:)",
		description:
			"Detects `.sink { ... }` / `.assign(to:on:)` whose result is not stored in an `AnyCancellable` collection — subscription is cancelled immediately when the local cancellable goes out of scope.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Attach `.store(in: &cancellables)` to retain the subscription for the publisher's lifetime, or hold the returned `AnyCancellable` in a property. Without retention, the cancellable deinits at the end of the enclosing scope and the subscription silently cancels.",
		fn: checkSwiftCombineNoStore,
		resultsPropName: "swiftCombineNoStore",
		content_keywords: [".sink", ".assign"],
	},

	// === Security ===
	{
		id: "swift_weak_crypto",
		phase: "post",
		name: "Swift Weak Crypto",
		description:
			"Detects MD5 / SHA-1 / DES usage in Swift via CommonCrypto, CryptoKit `Insecure.*`, or `kCCAlgorithmDES`. Broken for security-bearing use.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use a modern hash: `SHA256` / `SHA384` / `SHA512` from CryptoKit, or `kCCAlgorithmAES` for symmetric encryption. MD5 and SHA-1 are collision-broken; DES is brute-forceable in seconds. CryptoKit's `Insecure.MD5` / `Insecure.SHA1` exist for legacy interop only — pretty much never the right call in new code.",
		fn: checkSwiftWeakCrypto,
		resultsPropName: "swiftWeakCrypto",
		content_keywords: ["CC_MD5", "CC_SHA1", "Insecure", "kCCAlgorithmDES"],
	},
	{
		id: "swift_http_url_literal",
		phase: "post",
		name: "Swift http:// URL Literal",
		description:
			'Detects `URL(string: "http://...")` / `URLRequest(...)` with a plain HTTP URL in non-localhost contexts — defeats ATS and leaks traffic in cleartext.',
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `https://` for production URLs. App Transport Security blocks plain HTTP by default for good reason — eavesdropping, MITM, captive-portal redirects. Localhost / 127.0.0.1 / *.local are explicitly allowed by ATS, so dev URLs are fine.",
		fn: checkSwiftHttpUrlLiteral,
		resultsPropName: "swiftHttpUrlLiteral",
		content_keywords: ["http://"],
	},
	{
		id: "swift_userdefaults_for_secret",
		phase: "post",
		name: "Swift UserDefaults for Secret",
		description:
			"Detects `UserDefaults.*.set(...)` / property-wrapper `@AppStorage` writing a key whose name matches password/token/secret/api[_]key — UserDefaults is plaintext on disk.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Store credentials in the Keychain (`SecItemAdd` / `KeychainAccess` / Apple's `Authentication Services`). UserDefaults is a property list at `~/Library/Preferences/...` — readable by any local process with the right entitlement, plaintext in iCloud sync, plaintext in backups.",
		fn: checkSwiftUserDefaultsForSecret,
		resultsPropName: "swiftUserDefaultsForSecret",
		content_keywords: ["UserDefaults", "@AppStorage"],
	},
	{
		id: "swift_ats_arbitrary_loads",
		phase: "post",
		name: "Swift ATS Arbitrary Loads",
		description:
			"Detects `NSAllowsArbitraryLoads` / `NSExceptionAllowsInsecureHTTPLoads` set to true in an Info.plist — globally disables App Transport Security.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Remove `NSAllowsArbitraryLoads` and instead use `NSExceptionDomains` to allow specific domains over HTTP (e.g. a known-legacy API). A blanket ATS bypass is rejected at App Store review unless explicitly justified.",
		fn: checkSwiftAtsArbitraryLoads,
		resultsPropName: "swiftAtsArbitraryLoads",
		content_keywords: ["NSAllowsArbitraryLoads", "NSAppTransportSecurity"],
	},

	// === Quality / error handling ===
	{
		id: "swift_empty_catch",
		phase: "post",
		name: "Swift Empty catch",
		description:
			"Detects `catch { }` (or `catch let _ { }`) with no body — silently swallows the error.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Handle the error: log it, transform it into a sentinel value, rethrow, or at minimum leave a comment explaining the discard. An empty `catch` makes a thrown error indistinguishable from success — debugging anything downstream becomes guesswork.",
		fn: checkSwiftEmptyCatch,
		resultsPropName: "swiftEmptyCatch",
		content_keywords: ["catch"],
	},
	{
		id: "swift_try_question_discarded",
		phase: "post",
		name: "Swift try? Result Discarded",
		description:
			"Detects `try?` at statement position where the optional result is thrown away — both the error and the success value disappear.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"If you genuinely don't care about the result, write `_ = try? expr` explicitly (or `try expr` inside a `do { } catch { /* documented swallow */ }`). A bare `try?` at statement level discards both the throw and the return value — almost always a mistake.",
		fn: checkSwiftTryQuestionDiscarded,
		resultsPropName: "swiftTryQuestionDiscarded",
		content_keywords: ["try?"],
	},
	{
		id: "swift_nsurl_legacy_bridge",
		phase: "post",
		name: "Swift NSURL Legacy Bridge",
		description:
			"Detects `NSURL(string:)` / `NSURLRequest(url:)` — should be the Swift-native `URL` / `URLRequest`.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `URL(string: ...)` and `URLRequest(url: ...)` — the Swift-native value types. The `NSURL` / `NSURLRequest` reference types come from Objective-C bridging and lose value semantics. Modern Swift APIs all expect `URL`.",
		fn: checkSwiftNsurlLegacyBridge,
		resultsPropName: "swiftNsurlLegacyBridge",
		content_keywords: ["NSURL"],
	},
	{
		id: "swift_fatalerror_in_guard",
		phase: "post",
		name: "Swift fatalError in guard",
		description:
			"Detects `guard ... else { fatalError(...) }` — a force-unwrap dressed up with extra ceremony; signals the same bug class.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Either propagate the failure as a thrown error / optional return, or use a real force unwrap (`!`) so the harness sees it and the runtime crash is unambiguous. `guard ... else { fatalError() }` is force-unwrap with extra steps — same crash, harder to grep for, and the `fatalError` message is rarely informative.",
		fn: checkSwiftFatalErrorInGuard,
		resultsPropName: "swiftFatalErrorInGuard",
		content_keywords: ["guard", "fatalError"],
	},
	{
		id: "swift_print_in_view_body",
		phase: "post",
		name: "Swift print() in SwiftUI body",
		description:
			"Detects `print(...)` inside a SwiftUI `View`'s `body` computed property — the closure is re-evaluated on every state change.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Move the print out of `body`. SwiftUI re-evaluates `body` on every state invalidation — a single `print` can fire thousands of times per scroll, masking the real debug signal. Use `.onAppear { print(...) }`, `.onChange(of:)`, or set a breakpoint instead.",
		fn: checkSwiftPrintInViewBody,
		resultsPropName: "swiftPrintInViewBody",
		content_keywords: ["var body", "print"],
	},

	// === Performance ===
	{
		id: "swift_filter_count",
		phase: "post",
		name: "Swift .filter{}.count",
		description:
			"Detects `.filter { ... }.count` — allocates a throwaway array just to count.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `.count(where: { ... })` (Swift 6) or `.lazy.filter { ... }.count` (Swift 5) — both avoid the intermediate allocation. `.filter` produces a full `Array<Element>` even if you only want a size.",
		fn: checkSwiftFilterCount,
		resultsPropName: "swiftFilterCount",
		content_keywords: [".filter"],
	},

	// === Privacy / source leakage ===
	{
		id: "swift_file_id_over_file_path",
		phase: "post",
		name: "Swift #fileID over #file/#filePath",
		description:
			"Detects `#file` / `#filePath` in non-test code — both leak the developer's absolute file system path into binaries.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `#fileID` instead — it produces a short `Module/File.swift` form instead of leaking `/Users/<name>/.../File.swift` into your release binary. Apple's `Logger` / `os_log` accept `#fileID` directly. `#filePath` is only appropriate for tools that genuinely need an OS path (test runners).",
		fn: checkSwiftFileIdOverFilePath,
		resultsPropName: "swiftFileIdOverFilePath",
		content_keywords: ["#file"],
	},

	// === Style / Apple ADG ===
	{
		id: "swift_abbreviations",
		phase: "post",
		name: "Swift Abbreviations",
		description:
			"Detects common non-standard abbreviations (`btn`, `lbl`, `mgr`, `cfg`, `img`, etc.) in Swift identifiers. Apple ADG: 'Avoid abbreviations.'",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Spell out identifiers per Apple's API Design Guidelines: `button`, `label`, `manager`, `config`, `image`, `message`, `request`, `response`, `viewController`, `table`, `navigation`, `background`, `foreground`. Compressed names save four characters and cost every future reader a context switch.",
		fn: checkSwiftAbbreviations,
		resultsPropName: "swiftAbbreviations",
		content_keywords: [".swift"],
	},
];
