import { hasLegacyConfig, migrateLegacyConfig } from "../lib/config.js";
import type { CheckResult } from "./doctor-check-types.js";

/** Auth token presence. Localhost development downgrades absence to warn. */
export function authTokenCheck(token: string | null, isLocalDevServer: boolean): CheckResult {
	if (token) {
		return { name: "Auth token", status: "pass", message: "Token available" };
	}
	if (isLocalDevServer) {
		return {
			name: "Auth token",
			status: "warn",
			message: "No auth token (localhost dev mode allows unauthenticated access)",
		};
	}
	return { name: "Auth token", status: "fail", message: "No auth token -- run 'interlinked login'" };
}

/** Legacy `.claude/interlinked-session.json` detection + migration. */
export function legacyConfigCheck(cwd: string, fix: boolean): CheckResult[] {
	if (!hasLegacyConfig(cwd)) return [];
	if (fix && migrateLegacyConfig(cwd)) {
		return [
			{
				name: "Legacy config",
				status: "pass",
				message: "Migrated .claude/interlinked-session.json to .interlinked/",
			},
		];
	}
	return [
		{
			name: "Legacy config",
			status: "warn",
			message: "Found .claude/interlinked-session.json -- should migrate to .interlinked/",
			fixable: true,
			fixAction: "migrate",
		},
	];
}
