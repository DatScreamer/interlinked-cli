// interlinked-tdd: exempt
// ===========================================
// PostToolUse — post-write file quality warnings
// ===========================================
//
// File-level quality feedback after writes: size cap, JSON validity,
// package.json supply-chain checks, YAML tab detection, and
// suppression-comment justification. Extracted verbatim from post-tool.ts;
// the orchestrator calls only `collectPostWriteFileWarnings`.

import { readFileSync } from "node:fs";
import { checkPhantomDependencies, checkTyposquatDependencies } from "../generic-checks.js";
import { countLines, isCappableFile, maxLinesFor } from "../large-file-policy.js";
import type { HarnessEvent } from "../types.js";
import { isFileWrite } from "./tool-classifiers.js";

/** File-level quality feedback after writes: size, JSON validity, supply-chain
 *  checks on package.json, YAML, and suppression-comment detection. */
export function collectPostWriteFileWarnings(event: HarnessEvent): string[] {
	const warnings: string[] = [];
	const toolName = event.tool_name || "";
	if (!isFileWrite(toolName)) return warnings;

	const filePath =
		(event.tool_input?.file_path as string) || (event.tool_input?.path as string) || "";
	if (!filePath) return warnings;

	const ext = filePath.replace(/^.*\./, ".").toLowerCase();

	warnings.push(...collectFileSizeWriteWarning(event, filePath));
	if (ext === ".json") warnings.push(...collectJsonValidityWarning(filePath));
	if (filePath.endsWith("package.json") && !filePath.includes("node_modules")) {
		warnings.push(...collectSupplyChainWarnings(filePath));
	}
	if (ext === ".yaml" || ext === ".yml") warnings.push(...collectYamlValidityWarning(filePath));
	warnings.push(...collectSuppressionFileWarnings(filePath));
	return warnings;
}

/** File-size cap warning on write — only for hand-written code modules. */
function collectFileSizeWriteWarning(event: HarnessEvent, filePath: string): string[] {
	try {
		const content = readFileSync(filePath, "utf-8");
		if (!isCappableFile({ filePath, content })) return [];
		const lineCount = countLines(content);
		const cap = maxLinesFor(event.cwd || process.cwd());
		if (lineCount > cap) {
			return [
				`[interlinked:file-size] ${filePath} is ${lineCount} lines — over the ${cap}-line cap for hand-written code. Consider splitting into smaller, focused modules.`,
			];
		}
	} catch (_err) {
		/* best-effort — skip when unreadable */
	}
	return [];
}

/** JSON syntax validity after a write to a `.json` file. */
function collectJsonValidityWarning(filePath: string): string[] {
	try {
		JSON.parse(readFileSync(filePath, "utf-8"));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("Dynamic require")) {
			return [`[interlinked:json-validity] ${filePath} contains invalid JSON: ${msg}. Fix the syntax error.`];
		}
	}
	return [];
}

/** Supply-chain checks (phantom + typosquat deps) after editing package.json. */
function collectSupplyChainWarnings(filePath: string): string[] {
	const warnings: string[] = [];
	for (const dep of checkPhantomDependencies(filePath)) {
		warnings.push(
			`[interlinked:supply-chain] ${dep.text}\n` +
				"  → If this dependency is intentional, ensure it is imported somewhere. " +
				"Phantom dependencies with lifecycle scripts are the primary npm supply chain attack vector.",
		);
	}
	for (const ts of checkTyposquatDependencies(filePath)) {
		warnings.push(
			`[interlinked:supply-chain] ${ts.text}\n` +
				"  → Typosquatted packages are a common supply chain attack vector. Double-check the package name.",
		);
	}
	return warnings;
}

/** YAML tab-indentation check after a write to a `.yaml` / `.yml` file. */
function collectYamlValidityWarning(filePath: string): string[] {
	try {
		const content = readFileSync(filePath, "utf-8");
		if (/\t/.test(content)) {
			return [
				`[interlinked:yaml-validity] ${filePath} contains tab characters. YAML requires spaces for indentation.`,
			];
		}
	} catch (_err) {
		/* best-effort — skip */
	}
	return [];
}

/** Suppression-comment detection after a write to a TS/JS file. */
function collectSuppressionFileWarnings(filePath: string): string[] {
	if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(filePath)) return [];
	try {
		return formatSuppressionWarnings(filePath, readFileSync(filePath, "utf-8"));
	} catch (_err) {
		/* best-effort — skip */
		return [];
	}
}

/**
 * Per Lopopolo's `hyperbola/require-eslint-disable-justification` rule:
 * suppression directives must carry a reason. A bare `// @ts-ignore` is the
 * most common AI escape hatch — silent bypass with no audit trail.
 *
 * The recognized justification conventions, by tool:
 *   - `@ts-ignore` / `@ts-expect-error`: any non-empty text after the
 *     directive counts (TypeScript itself doesn't enforce a separator;
 *     the de-facto convention is a colon or a space-prefixed reason)
 *   - `eslint-disable` (any flavor): ESLint 7+ requires the `--` separator
 *     before the reason, e.g. `// eslint-disable-next-line foo -- reason`
 *   - `biome-ignore`: Biome requires a colon, e.g.
 *     `// biome-ignore lint/foo: reason`
 *   - `@ts-nocheck`: file-level directive with no per-line justification
 *     convention; not enforced here (just counted as informational)
 */
const SUPPRESSION_DIRECTIVES: ReadonlyArray<{
	label: string;
	re: RegExp;
	isJustified: (suffix: string) => boolean;
}> = [
	{
		label: "@ts-ignore",
		re: /\/\/\s*@ts-ignore\b([^\n]*)/,
		isJustified: (suffix) => /\S/.test(suffix.replace(/^[: \t]+/, "")),
	},
	{
		label: "@ts-expect-error",
		re: /\/\/\s*@ts-expect-error\b([^\n]*)/,
		isJustified: (suffix) => /\S/.test(suffix.replace(/^[: \t]+/, "")),
	},
	{
		label: "@ts-nocheck",
		re: /\/\/\s*@ts-nocheck\b([^\n]*)/,
		// File-level, no per-line justification convention — exempt.
		isJustified: () => true,
	},
	{
		label: "eslint-disable",
		re: /\/\/\s*eslint-disable(?:-next-line|-line)?\b([^\n]*)/,
		// ESLint 7+ convention: `// eslint-disable-next-line rule -- reason`.
		isJustified: (suffix) => / -- \S/.test(suffix),
	},
	{
		label: "biome-ignore",
		re: /\/\/\s*biome-ignore\b([^\n]*)/,
		// Biome convention: `// biome-ignore lint/foo: reason` (colon).
		isJustified: (suffix) => /:\s*\S/.test(suffix),
	},
];

interface SuppressionCounts {
	justified: number;
	unjustifiedLines: number[];
}

function analyzeSuppressions(content: string): Map<string, SuppressionCounts> {
	const byLabel = new Map<string, SuppressionCounts>();
	const lines = content.split("\n");
	for (const [i, line] of lines.entries()) {
		for (const { label, re, isJustified } of SUPPRESSION_DIRECTIVES) {
			const match = re.exec(line);
			if (!match) continue;
			const suffix = match[1] ?? "";
			const counts = byLabel.get(label) ?? { justified: 0, unjustifiedLines: [] };
			if (isJustified(suffix)) counts.justified++;
			else counts.unjustifiedLines.push(i + 1);
			byLabel.set(label, counts);
		}
	}
	return byLabel;
}

/** Maximum line numbers shown inline before truncating with an ellipsis. */
const MAX_LINES_SHOWN = 5;

function formatSuppressionWarnings(filePath: string, content: string): string[] {
	const byLabel = analyzeSuppressions(content);
	const unjustifiedParts: string[] = [];
	const justifiedParts: string[] = [];
	for (const [label, { justified, unjustifiedLines }] of byLabel) {
		if (unjustifiedLines.length > 0) {
			const shown = unjustifiedLines.slice(0, MAX_LINES_SHOWN).join(", ");
			const more = unjustifiedLines.length > MAX_LINES_SHOWN ? ", …" : "";
			unjustifiedParts.push(
				`${unjustifiedLines.length}x ${label} (lines: ${shown}${more})`,
			);
		}
		if (justified > 0) justifiedParts.push(`${justified}x ${label}`);
	}

	const out: string[] = [];
	if (unjustifiedParts.length > 0) {
		out.push(
			`[interlinked:suppressions-unjustified] ${filePath} has bare suppression comments without a reason: ` +
				`${unjustifiedParts.join(", ")}. Add a justification: ` +
				"`// @ts-ignore: <reason>`, `// eslint-disable-next-line <rule> -- <reason>`, " +
				"or `// biome-ignore lint/<rule>: <reason>`. " +
				"Bare disables silently bypass safety; justified ones leave an audit trail for reviewers.",
		);
	}
	if (justifiedParts.length > 0 && unjustifiedParts.length === 0) {
		out.push(
			`[interlinked:suppressions] ${filePath} has suppression comments (${justifiedParts.join(", ")}). ` +
				"All carry justifications — consider whether the underlying issue can be fixed instead of silenced.",
		);
	}
	return out;
}
