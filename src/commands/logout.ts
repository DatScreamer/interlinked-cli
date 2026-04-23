// ===========================================
// interlinked logout — Clear authentication credentials
// ===========================================
// Removes tokens from config.local.json without destroying
// other config (agent name, workspace, sync mode, etc.).

import {
	isConfigured,
	type LocalConfig,
	readLocalConfig,
	updateLocalConfig,
} from "../lib/config.js";
import { c } from "../lib/formatter.js";

interface LogoutOptions {
	all?: boolean;
	json?: boolean;
}

export async function logoutCommand(options: LogoutOptions): Promise<void> {
	const cwd = process.cwd();

	if (!isConfigured(cwd)) {
		if (options.json) {
			console.log(JSON.stringify({ status: "not_configured" }));
		} else {
			console.log(c.dim("Not configured. Nothing to log out from."));
		}
		return;
	}

	const local = readLocalConfig(cwd);
	if (!local) {
		if (options.json) {
			console.log(JSON.stringify({ status: "no_credentials" }));
		} else {
			console.log(c.dim("No local config found. Nothing to log out from."));
		}
		return;
	}

	const hadToken = !!local.access_token;
	const hadRefresh = !!local.refresh_token;
	const hadOauth = !!local.oauth_client_id;
	const hadHandle = !!local.agent_handle;

	if (!hadToken && !hadRefresh && !hadOauth) {
		if (options.json) {
			console.log(JSON.stringify({ status: "no_credentials" }));
		} else {
			console.log(c.dim("No credentials found in config. Already logged out."));
		}
		return;
	}

	// Clear auth-related fields
	const updates: Partial<LocalConfig> = {
		access_token: undefined,
		refresh_token: undefined,
		token_expires_at: undefined,
		oauth_client_id: undefined,
	};

	// --all also clears agent handle (requires re-registration)
	if (options.all) {
		updates.agent_handle = undefined;
	}

	updateLocalConfig(updates, cwd);

	if (options.json) {
		console.log(
			JSON.stringify({
				status: "logged_out",
				cleared: {
					access_token: hadToken,
					refresh_token: hadRefresh,
					oauth_client_id: hadOauth,
					agent_handle: options.all && hadHandle,
				},
			}),
		);
		return;
	}

	console.log(c.bold("Interlinked CLI — Logout"));
	console.log(c.dim("─".repeat(40)));

	if (hadToken) console.log(`  ${c.green("Cleared")} access token`);
	if (hadRefresh) console.log(`  ${c.green("Cleared")} refresh token`);
	if (hadOauth) console.log(`  ${c.green("Cleared")} OAuth client ID`);
	if (options.all && hadHandle) {
		console.log(`  ${c.green("Cleared")} agent handle`);
		console.log(c.dim("\n  Agent handle cleared. Re-registration required on next login."));
	}

	console.log(`\n${c.green("Logged out.")} Config preserved at .interlinked/config.local.json`);
	console.log(c.dim("To re-authenticate: interlinked login"));
}
