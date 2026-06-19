// Swift-specific checks (Apple API Design Guidelines + Memory Safety + Concurrency).
// Extracted from generic-checks.ts.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

export {
	checkSwiftDelegateNotWeak,
	checkSwiftForceCast,
	checkSwiftForceTry,
	checkSwiftForceUnwrap,
	checkSwiftImplicitlyUnwrappedOptional,
} from "./swift-memory-safety.js";
export {
	checkTestRegressions,
	extractEnvReferences,
	extractMockDefinitions,
	extractModuleExportNames,
} from "./swift-test-integrity.js";

/**
 * Detect legacy arc4random() usage in Swift.
 * Apple: Use Int.random(in:), Bool.random(), Collection.randomElement().
 */
export function checkSwiftLegacyRandom(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\barc4random/, 10);
}

/**
 * Detect legacy hashValue implementation.
 * Apple: Implement hash(into hasher: inout Hasher) instead.
 */
export function checkSwiftLegacyHashValue(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bvar\s+hashValue\s*:\s*Int\b/, 10);
}

/**
 * Detect #file or #filePath in non-test Swift code.
 * Apple: "Use #fileID — it produces smaller strings and avoids leaking the developer's file system."
 * Note: scans original lines because stripComments treats # as Python comment (which strips Swift directives).
 * Only skips lines that start with // (Swift single-line comments).
 */
export function checkSwiftFileIdOverFilePath(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = originalLines[i].trimStart();
		// Skip Swift comment lines
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*"))
			continue;
		if (/#file(?:Path)?\b(?!ID|Literal)/.test(originalLines[i])) {
			matches.push({
				line: i + 1,
				text: originalLines[i].trim().slice(0, 150),
			});
		}
	}

	return matches;
}

/**
 * Detect common non-standard abbreviations in Swift identifiers.
 * Apple ADG: "Avoid abbreviations. The expanded form is readily looked up."
 */
export function checkSwiftAbbreviations(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Common iOS/Swift abbreviations flagged by Apple's guidelines
	// Matches declarations (var/let/func name) and function parameter labels (funcName(lbl:))
	const abbrNames = /(?:btn|lbl|mgr|ctl|cfg|img|msg|req|res|vc|tbl|nav|bg|fg)\w*/;
	const abbrPattern = new RegExp(
		"(?:\\b(?:var|let|func)\\s+\\w*" +
			abbrNames.source +
			"\\b" +
			"|\\(\\s*" +
			abbrNames.source +
			"\\s*:)",
		"i",
	);

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		const origLine = originalLines[i];

		if (abbrPattern.test(line)) {
			matches.push({
				line: i + 1,
				text: origLine.trim().slice(0, 150),
			});
		}
	}

	return matches;
}

// --- Swift Concurrency Safety (SE-0302, SE-0306, SE-0337) ---

/**
 * Detect Task.detached usage — almost always wrong, breaks structured concurrency.
 * Apple docs: "Prefer Task {} or TaskGroup for structured concurrency."
 */
export function checkSwiftTaskDetached(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bTask\s*\.\s*detached\s*[({]/, 10);
}

/**
 * Detect unhandled errors in Task closures — errors silently swallowed.
 * Pattern: Task { try ... } without a do/catch inside.
 */
export function checkSwiftUnhandledTaskError(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// Match Task { or Task.detached { on this line
		if (!/\bTask\s*(?:\.\s*detached\s*)?\{/.test(line)) continue;

		// Scan the task body (up to 30 lines) for try without do/catch
		let depth = 0;
		let hasTry = false;
		let hasDoCatch = false;
		for (let j = i; j < Math.min(i + 30, strippedLines.length); j++) {
			for (const ch of strippedLines[j]) {
				if (ch === "{") depth++;
				if (ch === "}") depth--;
			}
			if (/\btry\b/.test(strippedLines[j]) && !/\btry[?!]/.test(strippedLines[j]))
				hasTry = true;
			if (/\bdo\s*\{/.test(strippedLines[j])) {
				// Look ahead for a matching catch within the task body
				for (let k = j + 1; k < Math.min(i + 30, strippedLines.length); k++) {
					if (/\bcatch\b/.test(strippedLines[k])) {
						hasDoCatch = true;
						break;
					}
				}
			}
			if (depth <= 0 && j > i) break;
		}

		if (hasTry && !hasDoCatch) {
			matches.push({
				line: i + 1,
				text: originalLines[i].trim().slice(0, 150),
			});
		}
	}

	return matches;
}

/**
 * Detect global mutable variables without actor isolation in Swift.
 * Swift 6: Global `var` must be isolated to a global actor or be Sendable.
 */
export function checkSwiftGlobalVarNoIsolation(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Track brace depth to identify file-scope declarations
	let braceDepth = 0;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		for (const ch of line) {
			if (ch === "{") braceDepth++;
			if (ch === "}") braceDepth--;
		}

		// Only check file-scope (depth 0) var declarations
		if (braceDepth !== 0) continue;

		// Match: var identifier (at file scope)
		if (!/^\s*(?:public\s+|internal\s+|fileprivate\s+|private\s+)?var\s+\w/.test(line))
			continue;
		// Skip if it has @MainActor or other actor isolation
		if (/@\w*Actor\b/.test(line) || /@\w*Actor\b/.test(strippedLines[Math.max(0, i - 1)]))
			continue;
		// Skip let (immutable is fine)
		if (/^\s*(?:public\s+|internal\s+|fileprivate\s+|private\s+)?let\s/.test(line)) continue;

		matches.push({
			line: i + 1,
			text: originalLines[i].trim().slice(0, 150),
		});
	}

	return matches;
}

/**
 * Detect self captured in escaping closures without capture list.
 * Apple Swift Book: "Use a capture list when referencing self in an escaping closure."
 */
export function checkSwiftSelfInEscapingClosure(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// Match @escaping closure parameter declarations
		if (!/@escaping/.test(line)) continue;

		// Scan forward for closure body containing self. without [weak self] or [unowned self]
		for (let j = i; j < Math.min(i + 20, strippedLines.length); j++) {
			if (/\[\s*(?:weak|unowned)\s+self\s*\]/.test(strippedLines[j])) break;
			if (/\bself\./.test(strippedLines[j]) && j > i) {
				matches.push({
					line: j + 1,
					text: originalLines[j].trim().slice(0, 150),
				});
				break;
			}
		}
	}

	return matches;
}

// --- Swift Performance Checks ---

/**
 * Detect .filter { ... }.count in Swift — allocates throwaway array just to count.
 * Use .count(where:) instead (available since Swift 5+).
 */
export function checkSwiftFilterCount(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\.filter\s*\{[^}]*\}\s*\.count\b/, 10);
}

// -------------------------------------------
// P0 Checks: Agent-Specific Failure Modes
// -------------------------------------------

/**
 * Parse documented env vars from .env.example, wrangler.toml, wrangler.jsonc, CI files.
 * Returns set of documented env var names.
 * NOTE: This function requires fs access. Import existsSync/readFileSync/readdirSync
 * and join from the caller's scope, or use it in contexts with Node.js require() available.
 */
export function parseEnvDocumentation(
	projectRoot: string,
	fs: {
		existsSync: (p: string) => boolean;
		readFileSync: (p: string, e: BufferEncoding) => string;
		readdirSync: (p: string) => string[];
	},
	pathJoin: (...parts: string[]) => string,
): Set<string> {
	const { existsSync, readFileSync, readdirSync } = fs;
	const join = pathJoin;
	const documented = new Set<string>();

	// In a monorepo, env-docs often live at the workspace root, not in the
	// sub-package being verified (e.g. `cli/` inside a parent repo). Walk
	// ancestor directories so `.env.example`, wrangler configs, and workflow
	// files are discovered wherever they sit — mirroring how git locates
	// `.git/` upward from the cwd. Capped to avoid unbounded walks.
	const roots: string[] = [];
	{
		let current = projectRoot;
		for (let i = 0; i < 8; i++) {
			roots.push(current);
			const parent = current.replace(/\/[^/]+\/?$/, "");
			if (!parent || parent === current || parent === "/") break;
			current = parent;
		}
	}

	// .env.example / .env.sample / .env.template
	for (const root of roots) {
		for (const name of [".env.example", ".env.sample", ".env.template"]) {
			const envPath = join(root, name);
			if (existsSync(envPath)) {
				try {
					const content = readFileSync(envPath, "utf-8");
					for (const line of content.split("\n")) {
						const m = line.match(/^#?\s*([A-Z][A-Z0-9_]+)\s*=/);
						if (m) documented.add(m[1]);
					}
				} catch {
					/* intentional: unreadable env docs should not break env discovery */
				}
			}
		}
	}

	// wrangler.toml / wrangler.jsonc [vars] + binding names. Parse one config file,
	// adding any var keys / binding names it declares to `documented`.
	const parseWranglerFile = (wranglerPath: string, isToml: boolean): void => {
		if (!existsSync(wranglerPath)) return;
		try {
			const content = readFileSync(wranglerPath, "utf-8");
			if (isToml) {
				let inVars = false;
				for (const line of content.split("\n")) {
					const binding = line.match(/^\s*(?:binding|name)\s*=\s*"([A-Z][A-Z0-9_]+)"/);
					if (binding) documented.add(binding[1]);
					if (/^\[vars\]/.test(line.trim())) {
						inVars = true;
						continue;
					}
					if (/^\[/.test(line.trim())) {
						inVars = false;
						continue;
					}
					if (inVars) {
						const m = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=/);
						if (m) documented.add(m[1]);
					}
				}
			} else {
				// JSONC: look for keys that look like env vars
				for (const line of content.split("\n")) {
					const m = line.match(/"([A-Z][A-Z0-9_]+)"\s*:/);
					if (m) documented.add(m[1]);
					const binding = line.match(/"(?:binding|name)"\s*:\s*"([A-Z][A-Z0-9_]+)"/);
					if (binding) documented.add(binding[1]);
				}
			}
		} catch {
			/* intentional: unreadable Wrangler config should not break env discovery */
		}
	};

	// Ancestor dirs (monorepo root + walk upward), same as the env-docs scan.
	for (const root of roots) {
		parseWranglerFile(join(root, "wrangler.toml"), true);
		parseWranglerFile(join(root, "wrangler.jsonc"), false);
	}

	// Immediate subdirectories of projectRoot. Worker bindings frequently live in
	// a sibling sub-app (e.g. `landing/wrangler.jsonc`) that the upward ancestor
	// walk never reaches. Bounded to one level deep; skip vendored / build / dot
	// dirs so this stays a small, fixed-cost scan.
	try {
		for (const entry of readdirSync(projectRoot)) {
			if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
			const subdir = join(projectRoot, entry);
			parseWranglerFile(join(subdir, "wrangler.toml"), true);
			parseWranglerFile(join(subdir, "wrangler.jsonc"), false);
		}
	} catch {
		/* intentional: unreadable project root should not break env discovery */
	}

	// GitHub Actions workflows
	for (const root of roots) {
		const workflowDir = join(root, ".github", "workflows");
		if (!existsSync(workflowDir)) continue;
		try {
			for (const file of readdirSync(workflowDir)) {
				if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
				const content = readFileSync(join(workflowDir, file), "utf-8");
				// env: blocks
				const envMatches = content.matchAll(/^\s+([A-Z][A-Z0-9_]+)\s*:/gm);
				for (const m of envMatches) documented.add(m[1]);
				// ${{ secrets.VAR }}
				const secretMatches = content.matchAll(
					/\$\{\{\s*secrets\.([A-Z][A-Z0-9_]+)\s*\}\}/g,
				);
				for (const m of secretMatches) documented.add(m[1]);
			}
		} catch {
			/* intentional: unreadable workflow files should not break env discovery */
		}
	}

	return documented;
}
