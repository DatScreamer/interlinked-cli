// interlinked-tdd: exempt
// Swift memory-safety checks extracted from swift.ts (force casts/try/unwrap,
// implicitly-unwrapped optionals, delegate retain-cycle risk).

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Swift-Specific Checks (Apple API Design Guidelines + Memory Safety + Concurrency)
// ===========================================

/**
 * Detect force casts (as!) in Swift — runtime crash if type doesn't match.
 * Apple ADG: "Use conditional casts (as?) unless failure is a programming error."
 */
export function checkSwiftForceCast(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bas!\s/, 10);
}

/**
 * Detect force try (try!) in Swift — runtime crash if the call throws.
 * Use do/catch or try? instead.
 */
export function checkSwiftForceTry(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\btry!\s/, 10);
}

/**
 * Detect force unwrap (!) on optionals in Swift — runtime crash if nil.
 * Skips @IBOutlet lines (standard UIKit pattern), string interpolation (!= operator),
 * and boolean negation patterns.
 */
export function checkSwiftForceUnwrap(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		const origLine = originalLines[i];
		if (line === undefined || origLine === undefined) continue;

		// Skip @IBOutlet lines — standard UIKit pattern uses implicitly unwrapped optionals
		if (/@IBOutlet/.test(origLine)) continue;
		// Skip lines that are just boolean negation (!flag) or not-equal (!=)
		// Match identifier followed by ! at end of expression context (not !=, not !identifier)
		// Pattern: word char or ) followed by ! then non-= (force unwrap)
		const forceUnwrapPattern = /[\w)\]]\s*!(?!=)/;
		if (!forceUnwrapPattern.test(line)) continue;
		// Skip `as!` (handled by checkSwiftForceCast) and `try!` (handled by checkSwiftForceTry)
		if (/\bas!\s/.test(line) || /\btry!\s/.test(line)) continue;

		matches.push({
			line: i + 1,
			text: origLine.trim().slice(0, 150),
		});
	}

	return matches;
}

/**
 * Detect implicitly unwrapped optionals (Type!) outside @IBOutlet declarations.
 * Apple: "Implicitly unwrapped optionals are a code smell outside of two-phase init and IB outlets."
 */
export function checkSwiftImplicitlyUnwrappedOptional(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		const origLine = nonNull(originalLines[i]);

		// Skip @IBOutlet — standard UIKit pattern
		if (/@IBOutlet/.test(origLine)) continue;
		// Match property declarations with Type!
		// Pattern: var/let identifier: SomeType!
		if (/\b(?:var|let)\s+\w+\s*:\s*\w[\w.<>, ]*!/.test(line)) {
			// Exclude as!/try! which have their own checks
			if (/\bas!\s/.test(line) || /\btry!\s/.test(line)) continue;
			matches.push({
				line: i + 1,
				text: origLine.trim().slice(0, 150),
			});
		}
	}

	return matches;
}

/**
 * Detect delegate properties not declared as weak — retain cycle risk.
 * Apple Swift Book: "Define delegates as weak references to avoid reference cycles."
 */
export function checkSwiftDelegateNotWeak(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		const origLine = nonNull(originalLines[i]);

		// Match: var delegate: SomeType (without weak keyword preceding)
		if (/\bvar\s+\w*[Dd]elegate\s*:\s*\w/.test(line) && !/\bweak\s+var\b/.test(line)) {
			matches.push({
				line: i + 1,
				text: origLine.trim().slice(0, 150),
			});
		}
	}

	return matches;
}
