// Shared shell command builder for runner settings fragments.

export function buildHookCommand(binaryPath: string, runner: string, event: string): string {
	return [
		"if test -f",
		shellQuote(binaryPath),
		"; then",
		"node",
		shellQuote(binaryPath),
		"--runner",
		shellQuote(runner),
		"--event",
		shellQuote(event),
		"; fi",
	].join(" ");
}

/**
 * Detached (fire-and-forget) variant for events whose output the runner never
 * consumes. The subshell backgrounds node and the outer shell returns in
 * milliseconds, so a runner that tears down immediately after its own work —
 * `claude update` is the observed case: it fires SessionEnd and exits, which
 * cancels any still-booting foreground hook ("Hook cancelled") — has nothing
 * left to cancel. Node still reads the payload from the inherited stdin pipe;
 * stdout/stderr go to /dev/null so the detached process can never write to a
 * closed pipe. ONLY for output-less events (SessionEnd): Stop/SessionStart/
 * PostToolUse emit context or block decisions and must stay foreground.
 */
export function buildDetachedHookCommand(
	binaryPath: string,
	runner: string,
	event: string,
): string {
	return [
		"if test -f",
		shellQuote(binaryPath),
		"; then",
		"( node",
		shellQuote(binaryPath),
		"--runner",
		shellQuote(runner),
		"--event",
		shellQuote(event),
		">/dev/null 2>&1 & )",
		"; fi",
	].join(" ");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
