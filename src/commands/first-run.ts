// ===========================================
// First-Run Entry Flow
// ===========================================
// Invoked when users run `interlinked` with no arguments.
// - If not configured: run the harness-first setup wizard (TTY) or the
//   env-driven local-first bootstrap (non-TTY) — both in setup-wizard-run.ts.
// - If configured: show status dashboard.
//
// 2026-08-16 rework: the old flow here asked only server-era questions
// (server URL, sync mode, login) and silently inherited every harness
// default. The server is dormant (CLAUDE.md: the local harness is the
// product), so the first touch now runs the decision wizard — runners, mode,
// scope, caps, brownfield adopt — and never mentions a server. Server users
// still have `interlinked enable --server` / `interlinked login` explicitly.

import { resolveAuthToken } from "../lib/auth.js";
import { isConfigured, resolveConfig } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import {
	runSetupWizardInteractive,
	runSetupWizardNonInteractive,
} from "./setup-wizard-run.js";
import { statusCommand } from "./status.js";

function isInteractiveTty(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function isLocalServer(serverUrl: string): boolean {
	return serverUrl.includes("localhost") || serverUrl.includes("127.0.0.1");
}

function printEntrypointQuickStart(): void {
	const config = resolveConfig();
	const hasAuth = Boolean(resolveAuthToken());
	const localServer = isLocalServer(config.server_url);

	const suggestions: string[] = [];
	if (!config.agent_name) {
		suggestions.push("interlinked attach --agent <name>");
	}
	if (!localServer && !hasAuth) {
		suggestions.push("interlinked login");
	}
	suggestions.push("interlinked activity --since 1h");
	if (config.sync_mode !== "local") {
		suggestions.push("interlinked sync");
	}
	suggestions.push("interlinked tasks list");
	suggestions.push("interlinked --help");

	if (suggestions.length === 0) return;

	console.log("");
	console.log(c.bold("Command Quick Start"));
	console.log(c.dim("───────────────────"));
	for (const command of suggestions) {
		console.log(`  ${command}`);
	}
}

export async function handleImplicitEntry(): Promise<boolean> {
	const argv = process.argv.slice(2);
	if (argv.length > 0) return false;

	if (!isConfigured()) {
		if (isInteractiveTty()) {
			await runSetupWizardInteractive();
			await statusCommand({ short: true });
		} else {
			await runSetupWizardNonInteractive();
		}
		return true;
	}

	await statusCommand({});
	if (isInteractiveTty()) {
		printEntrypointQuickStart();
	}
	return true;
}
