// Swift concurrency safety checks: Dispatch / Task / actors.
//
// Companion to `swift.ts` (where the original Task.detached / unhandled-task
// detectors live). New family file so swift.ts stays under the per-file cap
// and concurrency-specific patterns are colocated.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

/**
 * Detect `DispatchQueue.main.sync` — the canonical iOS / macOS self-deadlock.
 * Calling `.sync` on the main queue from the main thread blocks forever; calling
 * it from any thread that the main queue might call back into has the same risk.
 * Apple's Concurrency Programming Guide calls this out explicitly.
 *
 * The safe forms are:
 *   - `DispatchQueue.main.async { ... }` (fire-and-forget main-thread work)
 *   - `await MainActor.run { ... }` (Swift-concurrency main-thread hop)
 *   - `await Task { @MainActor in ... }.value` (await-able main-thread work)
 */
export function checkSwiftDispatchMainSync(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\bDispatchQueue\s*\.\s*main\s*\.\s*sync\b/,
		10,
	);
}

/**
 * Detect `Task.sleep(nanoseconds:)` — replaced by `Task.sleep(for:)` /
 * `Task.sleep(until:clock:)` in Swift 5.7 (SE-0329). The nanoseconds variant
 * is `@available(*, deprecated, ...)` and survives mostly via copy-paste from
 * older tutorials.
 *
 * The duration-based form is unit-safe: `Task.sleep(for: .seconds(1))` reads
 * the same as the wall-clock concept; `Task.sleep(nanoseconds: 1_000_000_000)`
 * is a magic number that decays the moment someone edits the literal.
 */
export function checkSwiftTaskSleepLegacy(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\bTask\s*\.\s*sleep\s*\(\s*nanoseconds\s*:/,
		10,
	);
}
