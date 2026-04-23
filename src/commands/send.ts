// ===========================================
// interlinked send — Send a message via the Interlinked MCP Server
// ===========================================
// Thin wrapper around send_message MCP tool.

import { readFileSync } from "node:fs";
import { getClient } from "../lib/api-client.js";
import { c } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export async function sendCommand(
	to: string,
	message?: string,
	opts?: {
		file?: string;
		importance?: string;
		json?: boolean;
	},
): Promise<void> {
	const mode = getOutputMode(opts || {});

	const client = getClient();
	if (!client.isAuthenticated() && !client.isLocalDevServer()) {
		outputError(mode, "Not authenticated. Run: interlinked login");
		return;
	}

	// Resolve message body from argument or file
	let body = message || "";
	if (opts?.file) {
		try {
			body = readFileSync(opts.file, "utf-8");
		} catch (_err) {
			outputError(mode, `Could not read file: ${opts.file}`);
			return;
		}
	}

	if (!body.trim()) {
		outputError(mode, "Message body is empty. Provide a message or --file.");
		return;
	}

	try {
		const configuredAgentName = client.getConfig().agent_name?.trim();
		if (!configuredAgentName) {
			outputError(
				mode,
				"agent_name is required. Set it with 'interlinked enable --agent <name>' or pass INTERLINKED_AGENT_NAME.",
			);
			return;
		}

		const result = await client.callTool("send_message", {
			sender_name: configuredAgentName,
			to: [to],
			body_md: body,
			importance: opts?.importance || "normal",
		});

		output(mode, result, {
			json: () => result,
			normal: () => c.green(`Message sent to ${c.bold(to)}`),
		});
	} catch (err) {
		outputError(
			mode,
			`Interlinked MCP Server error: ${err instanceof Error ? err.message : String(err)}`,
			{
				hint: "Is the Interlinked MCP Server reachable?",
			},
		);
	}
}
