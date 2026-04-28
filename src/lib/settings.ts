// ===========================================
// Client Discovery
// ===========================================
// Detects local AI coding clients and their settings locations.
// To add a new client (Cursor, Copilot, Opencode, Amp, etc.):
//   1. Add the name to ClientName
//   2. Add an entry to CLIENT_CONFIGS
//   3. Add install/uninstall functions in hooks.ts
//   4. Add a normalizer + detector in the generated hook script

import { existsSync } from "node:fs";
import { join } from "node:path";

export type ClientName = "claude" | "copilot" | "gemini" | "codex" | "cursor";

interface ClientConfig {
	name: ClientName;
	label: string;
	configDir: string;
	settingsFile: string;
	inputMethod: "stdin" | "argv";
}

/**
 * Registry of supported AI coding clients.
 * Each entry describes how the client stores settings and receives hook data.
 */
const CLIENT_CONFIGS: ClientConfig[] = [
	{
		name: "claude",
		label: "Claude Code",
		configDir: ".claude",
		settingsFile: "settings.json",
		inputMethod: "stdin",
	},
	{
		name: "copilot",
		label: "GitHub Copilot CLI",
		configDir: ".github/hooks",
		settingsFile: "hooks.json",
		inputMethod: "stdin",
	},
	{
		name: "gemini",
		label: "Google Gemini CLI",
		configDir: ".gemini",
		settingsFile: "settings.json",
		inputMethod: "stdin",
	},
	{
		name: "codex",
		label: "OpenAI Codex CLI",
		configDir: ".codex",
		settingsFile: "hooks.json",
		inputMethod: "stdin",
	},
	{
		name: "cursor",
		label: "Cursor IDE",
		// Cursor's hook config lives at `<project>/.cursor/hooks.json` (project
		// scope) and `~/.cursor/hooks.json` (user scope). We install at project
		// scope to match how the other clients work — global install is a
		// future enhancement gated on the user-config-tier wiring.
		configDir: ".cursor",
		settingsFile: "hooks.json",
		inputMethod: "stdin",
	},
	// Future client shapes (documented for extension; NOT commented-out code —
	// each line below is an example of a ClientConfig entry you might add):
	//   Example: opencode → configDir: ".opencode", settingsFile: "config.json",   inputMethod: "stdin"
	//   Example: amp      → configDir: ".amp",      settingsFile: "settings.json", inputMethod: "stdin"
];

interface DetectedClient {
	name: ClientName;
	settingsPath: string;
	exists: boolean;
}

function getClientSettingsPath(cwd: string, client: ClientConfig): string {
	return join(cwd, client.configDir, client.settingsFile);
}

export function detectClients(cwd: string): DetectedClient[] {
	return CLIENT_CONFIGS.map((config) => ({
		name: config.name,
		settingsPath: getClientSettingsPath(cwd, config),
		exists: existsSync(join(cwd, config.configDir)),
	}));
}
