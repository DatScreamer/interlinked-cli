// ===========================================
// Tool Miss Detection
// ===========================================
//
// PostToolUse heuristic: when a Bash command produces "command not found"
// output or BSD/GNU option incompatibilities (very common on macOS agents),
// emit a targeted install/remediation hint. Runs only on short error-text
// buffers to keep the cost negligible.

/** Known error-message → install hint pairings. The order of entries is
 *  preserved; first match wins. */
const TOOL_MISS_FIXES: Array<{ pattern: RegExp; fix: string }> = [
	// "command not found" with known tools
	{
		pattern: /\bgrep:\s+invalid option\b.*-P/i,
		fix: "macOS grep lacks -P (PCRE). Install GNU grep: brew install grep (use as ggrep, or add to PATH)",
	},
	{
		pattern: /\bsed:\s+.*-i.*requires an extension/i,
		fix: "macOS sed requires: sed -i '' (empty string arg). Or install GNU sed: brew install gnu-sed",
	},
	{
		pattern: /\breadlink:.*illegal option.*-f/i,
		fix: "macOS readlink lacks -f. Install coreutils: brew install coreutils (use greadlink -f)",
	},
	{
		pattern: /\bdate:.*illegal option.*-d/i,
		fix: "macOS date lacks -d. Install coreutils: brew install coreutils (use gdate)",
	},
	{
		pattern: /\bxargs:.*illegal option.*-r/i,
		fix: "macOS xargs lacks -r (no-run-if-empty). On macOS, xargs already behaves this way by default",
	},
	{
		pattern: /\bsort:.*illegal option.*-V/i,
		fix: "macOS sort lacks -V (version sort). Install coreutils: brew install coreutils (use gsort)",
	},
	// Common "command not found"
	{
		pattern: /(?:command not found|not found):\s*rg\b/i,
		fix: "ripgrep (rg) not installed. Install: brew install ripgrep",
	},
	{
		pattern: /(?:command not found|not found):\s*fd\b/i,
		fix: "fd not installed. Install: brew install fd",
	},
	{
		pattern: /(?:command not found|not found):\s*bat\b/i,
		fix: "bat not installed. Install: brew install bat",
	},
	{
		pattern: /(?:command not found|not found):\s*jq\b/i,
		fix: "jq not installed. Install: brew install jq",
	},
	{
		pattern: /(?:command not found|not found):\s*yq\b/i,
		fix: "yq not installed. Install: brew install yq",
	},
	{
		pattern: /(?:command not found|not found):\s*gh\b/i,
		fix: "GitHub CLI (gh) not installed. Install: brew install gh",
	},
	{
		pattern: /(?:command not found|not found):\s*bun\b/i,
		fix: "Bun not installed. Install: brew install oven-sh/bun/bun",
	},
	{
		pattern: /(?:command not found|not found):\s*pnpm\b/i,
		fix: "pnpm not installed. Install: brew install pnpm",
	},
];

/** Skip obviously-empty or huge outputs — tool-miss detection is cheap
 *  heuristic matching, not worth running on buffers that aren't error text. */
const TOOL_MISS_MIN_OUTPUT_CHARS = 5;
const TOOL_MISS_MAX_OUTPUT_CHARS = 10_000;

/** Public API — consumed by evaluator.ts PostToolUse path to detect
 *  "command not found" or BSD/GNU incompatibilities in Bash output and
 *  return an install hint, or null if nothing matches. */
export function detectToolMiss(output: string): string | null {
	if (output.length < TOOL_MISS_MIN_OUTPUT_CHARS || output.length > TOOL_MISS_MAX_OUTPUT_CHARS) {
		return null;
	}
	for (const { pattern, fix } of TOOL_MISS_FIXES) {
		if (pattern.test(output)) {
			return `[interlinked:tool-miss] ${fix}`;
		}
	}
	return null;
}
