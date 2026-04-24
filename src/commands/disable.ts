// ===========================================
// interlinked disable — Remove hooks and optionally clean config
// ===========================================
// Uninstalls hooks from all detected AI coding clients and
// optionally removes the .interlinked/ directory.

import { getConfigDir, isConfigured } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { deleteConfigDir, deleteHookScript, uninstallAllHooks } from "../lib/hooks.js";
import { type ClientName, detectClients } from "../lib/settings.js";

interface DisableOptions {
	keepConfig?: boolean;
}

export async function disableCommand(options: DisableOptions): Promise<void> {
	const cwd = process.cwd();

	console.log(c.bold("Interlinked CLI — Disable Hook Management"));
	console.log(c.dim("─".repeat(40)));

	if (!isConfigured(cwd)) {
		console.log(`\n${c.dim("Not enabled.")} No .interlinked/ config found.`);
		console.log(c.dim("Checking for hooks to remove anyway...\n"));
	}

	// Step 1: Detect all clients that might have hooks
	const _detected = detectClients(cwd);
	const allClients: ClientName[] = ["claude", "copilot"];

	// Try to uninstall from all known clients (not just detected ones)
	// because hooks might exist even if the client dir was removed
	console.log(c.bold("Removing hooks:"));

	const results = uninstallAllHooks(cwd, allClients);
	let removedCount = 0;

	for (const result of results) {
		if (result.events.length > 0) {
			console.log(
				`  ${c.red("-")} ${c.bold(result.client)} — removed ${result.events.length} hook event(s)`,
			);
			removedCount++;
		} else if (result.error) {
			console.log(`  ${c.red("x")} ${c.bold(result.client)} — ${c.red(result.error)}`);
		} else {
			console.log(`  ${c.dim("-")} ${c.bold(result.client)} — no hooks found`);
		}
	}

	// Step 2: Delete hook script
	const scriptDeleted = deleteHookScript(cwd);
	if (scriptDeleted) {
		console.log(`\n${c.red("Deleted")} hook script`);
	}

	// Step 3: Handle .interlinked/ directory
	if (options.keepConfig) {
		console.log(`\n${c.dim("Kept")} .interlinked/ config (--keep-config)`);
	} else {
		const configDir = getConfigDir(cwd);
		const dirDeleted = deleteConfigDir(cwd);
		if (dirDeleted) {
			console.log(`\n${c.red("Deleted")} ${configDir.replace(`${cwd}/`, "")}/`);
		}
	}

	// Summary
	if (removedCount > 0) {
		console.log(`\n${c.green("Done.")} Removed hooks from ${removedCount} client(s).`);
	} else {
		console.log(`\n${c.dim("Done.")} No hooks were found to remove.`);
	}

	console.log(c.dim("Agent activity will no longer be captured."));

	if (!options.keepConfig) {
		console.log(c.dim("Run 'interlinked enable' to re-enable."));
	} else {
		console.log(c.dim("Config preserved. Run 'interlinked enable' to re-install hooks."));
	}
}
