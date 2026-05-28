// Swift lifecycle / resource-leak checks:
// NotificationCenter observers, Timer, Combine cancellables.
//
// Each detector uses a file-scope absence-of-pairing heuristic: if the file
// contains the acquisition call but no matching release/store call anywhere
// in the file, flag every acquisition site. This is a deliberately coarse
// heuristic — a single file's view of the lifecycle catches the >95% case
// without trying to model object boundaries across files.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	stripCommentsAndStrings,
} from "./shared.js";

const MATCH_LIMIT = 10;

/**
 * Detect `NotificationCenter.*.addObserver(...)` in a class without a matching
 * `removeObserver` anywhere in the file.
 *
 * Selector-based observers (`addObserver(_:selector:name:object:)`) are auto-
 * removed by the runtime on dealloc since iOS 9, but block-based observers
 * (`addObserver(forName:object:queue:using:)`) leak unless explicitly removed.
 * The detector flags both because (a) the block-based form is the common
 * source of real leaks, and (b) old selector-based code in a long-lived
 * singleton still benefits from explicit removal.
 */
export function checkSwiftNotificationObserverNoRemoval(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	if (!/\baddObserver\s*\(/.test(stripped)) return [];
	if (/\bremoveObserver\s*\(/.test(stripped)) return [];

	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (/\baddObserver\s*\(/.test(strippedLines[i])) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect `Timer.scheduledTimer(...)` without any `invalidate()` call in the file.
 *
 * A scheduled timer keeps a strong reference to its target via the run loop;
 * without `invalidate()`, neither the timer nor its owner can be deallocated.
 * Both block-based (`withTimeInterval:repeats:block:`) and selector-based
 * (`timeInterval:target:selector:userInfo:repeats:`) forms have the leak.
 */
export function checkSwiftTimerNoInvalidate(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	if (!/\bTimer\s*\.\s*scheduledTimer\s*\(/.test(stripped)) return [];
	if (/\.\s*invalidate\s*\(\s*\)/.test(stripped)) return [];

	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (/\bTimer\s*\.\s*scheduledTimer\s*\(/.test(strippedLines[i])) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect Combine `.sink { ... }` / `.assign(to:on:)` whose returned cancellable
 * isn't retained anywhere via `.store(in: &<bag>)`.
 *
 * Without retention, the cancellable deinits at end-of-scope and the
 * subscription silently cancels — a classic "the publisher fires but my
 * handler never runs" bug.
 *
 * Variants explicitly NOT flagged:
 *   - `@Published` assignment (`.assign(to: &$publishedProperty)`) — the
 *     `to:` parameter taking an `inout Published` is a separate API that
 *     manages its own lifecycle; we look for `.store(in:` regardless.
 *   - `await publisher.values` (async-sequence form) — no cancellable
 *     surface area; this detector doesn't match `.values`.
 */
export function checkSwiftCombineNoStore(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	if (!/\.\s*(?:sink|assign)\s*[({]/.test(stripped)) return [];
	if (/\.\s*store\s*\(\s*in\s*:/.test(stripped)) return [];

	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (/\.\s*(?:sink|assign)\s*[({]/.test(strippedLines[i])) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}
