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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
