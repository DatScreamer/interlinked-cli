// ===========================================
// Output Modes — Progressive Disclosure
// ===========================================
// Supports --json, --short, --full output modes across all commands.

/**
 * Output mode for command responses.
 * - json: Machine-readable JSON output
 * - short: One-line summary
 * - normal: Default readable output
 * - full: Detailed output with all fields
 */
type OutputMode = "json" | "short" | "normal" | "full";

/**
 * Determine output mode from command options.
 */
export function getOutputMode(options: {
	json?: boolean;
	short?: boolean;
	full?: boolean;
}): OutputMode {
	if (options.json) return "json";
	if (options.short) return "short";
	if (options.full) return "full";
	return "normal";
}

/**
 * Output data according to the selected mode.
 * Handlers provide render functions for each mode.
 */
export function output(
	mode: OutputMode,
	data: unknown,
	renderers: {
		json?: () => unknown;
		short?: () => string;
		normal: () => string;
		full?: () => string;
	},
): void {
	switch (mode) {
		case "json":
			console.log(JSON.stringify(renderers.json ? renderers.json() : data, null, 2));
			break;
		case "short":
			console.log(renderers.short ? renderers.short() : renderers.normal());
			break;
		case "full":
			console.log(renderers.full ? renderers.full() : renderers.normal());
			break;
		case "normal":
			console.log(renderers.normal());
			break;
		default: {
			// Exhaustiveness guard: adding a new OutputMode without a matching
			// case above turns this assignment into a compile error.
			const _exhaustive: never = mode;
			throw new Error(`unhandled output mode: ${String(_exhaustive)}`);
		}
	}
}

/**
 * Error output: human-friendly in normal mode, structured in JSON mode.
 */
export function outputError(mode: OutputMode, message: string, details?: unknown): void {
	if (mode === "json") {
		console.error(JSON.stringify({ error: message, details }, null, 2));
	} else {
		console.error(`Error: ${message}`);
		if (details && mode === "full") {
			console.error(JSON.stringify(details, null, 2));
		}
	}
	process.exitCode = 1;
}

/**
 * Success message (suppressed in JSON mode).
 */
export function outputSuccess(mode: OutputMode, message: string): void {
	if (mode === "json") return;
	console.log(message);
}
