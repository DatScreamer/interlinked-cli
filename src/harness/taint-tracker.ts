// ===========================================
// Taint Tracker — Trajectory-level sensitivity tracking
// ===========================================
// Implements Bell-LaPadula-inspired information flow control (IFC/MLS).
// Once a session reads sensitive data, its label ratchets UP (never down).
// Outbound network commands are blocked when sensitivity reaches threshold.

import type { SensitivityLevel, SessionTrajectory, TaintTrackingConfig } from "./types.js";

// ===========================================
// Sensitivity Level Ordering
// ===========================================

/** Numeric ordering for monotone sensitivity ratcheting (Bell-LaPadula MLS model) */
export const SENSITIVITY_ORDER: Record<SensitivityLevel, number> = {
	Public: 0,
	Internal: 1,
	Confidential: 2,
	HighlyConfidential: 3,
};

// ===========================================
// Default Configuration
// ===========================================

export const DEFAULT_TAINT_CONFIG: TaintTrackingConfig = {
	enabled: true,
	file_sensitivity: [
		// HighlyConfidential — raw key material, cloud credentials
		{ glob: "**/*.pem", level: "HighlyConfidential" },
		{ glob: "**/*.key", level: "HighlyConfidential" },
		{ glob: "**/*.p12", level: "HighlyConfidential" },
		{ glob: "**/*.pfx", level: "HighlyConfidential" },
		{ glob: "**/*.jks", level: "HighlyConfidential" },
		{ glob: "**/.ssh/id_*", level: "HighlyConfidential" },
		{ glob: "**/.aws/credentials", level: "HighlyConfidential" },
		{
			glob: "**/.config/gcloud/application_default_credentials.json",
			level: "HighlyConfidential",
		},
		{ glob: "**/.azure/accessTokens.json", level: "HighlyConfidential" },
		{ glob: "**/.azure/msal_token_cache*", level: "HighlyConfidential" },
		{ glob: "**/.kube/config", level: "HighlyConfidential" },
		{ glob: "**/.oci/oci_api_key*", level: "HighlyConfidential" },

		// Confidential — env files, secrets directories
		// Exclude placeholder templates (they contain "your-api-key-here", not real secrets)
		{ glob: "**/.env.example", level: "Public" },
		{ glob: "**/.env.sample", level: "Public" },
		{ glob: "**/.env.template", level: "Public" },
		{ glob: "**/.env", level: "Confidential" },
		{ glob: "**/.env.*", level: "Confidential" },
		{ glob: "**/secrets/**", level: "Confidential" },
		{ glob: "**/secret/**", level: "Confidential" },
		{ glob: "**/credentials.json", level: "Confidential" },
		{ glob: "**/service-account*.json", level: "Confidential" },
		{ glob: "**/.gcloud/**", level: "Confidential" },

		// Internal — local config, interlinked config
		{ glob: "**/.interlinked/config.local.json", level: "Internal" },
		{ glob: "**/config.local.*", level: "Internal" },
	],
	step_limits: {
		Public: Number.POSITIVE_INFINITY,
		Internal: 1000,
		Confidential: 500,
		HighlyConfidential: 100,
	},
	network_block_at: "Confidential",
};

// ===========================================
// Network Command Detection
// ===========================================

const NETWORK_COMMANDS = /\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|ftp)\b/i;
const NETWORK_PIPE = /\|\s*(curl|wget|nc|ncat|netcat|ssh|socat)\b/i;
const PUBLISH_COMMANDS =
	/\b(npm\s+publish|cargo\s+publish|pip\s+upload|twine\s+upload|gem\s+push)\b/i;

/** Check if a shell command involves network communication */
export function isNetworkCommand(command: string): boolean {
	return (
		NETWORK_COMMANDS.test(command) ||
		NETWORK_PIPE.test(command) ||
		PUBLISH_COMMANDS.test(command)
	);
}

// ===========================================
// File Sensitivity Classification
// ===========================================

/** Classify a file's sensitivity based on its path */
export function classifyFileSensitivity(
	filePath: string,
	config: TaintTrackingConfig,
): SensitivityLevel {
	for (const entry of config.file_sensitivity) {
		if (sensitivityGlobMatch(filePath, entry.glob)) {
			return entry.level;
		}
	}
	return "Public";
}

// ===========================================
// Taint Ratchet
// ===========================================

/** Ratchet session sensitivity upward if the new level is higher */
export function ratchetSensitivity(
	session: SessionTrajectory,
	file: string,
	level: SensitivityLevel,
	config: TaintTrackingConfig,
): boolean {
	const currentOrder = SENSITIVITY_ORDER[session.sensitivity_level];
	const newOrder = SENSITIVITY_ORDER[level];

	if (newOrder > currentOrder) {
		session.sensitivity_level = level;
		session.step_limit = config.step_limits[level];
		session.taint_sources.push({
			file,
			level,
			at_step: session.tool_call_count,
		});
		return true; // Sensitivity was escalated
	}
	return false;
}

// ===========================================
// Taint Checks
// ===========================================

/** Check if outbound network should be blocked at current sensitivity */
export function shouldBlockNetwork(
	session: SessionTrajectory,
	config: TaintTrackingConfig,
): boolean {
	const sessionOrder = SENSITIVITY_ORDER[session.sensitivity_level];
	const blockOrder = SENSITIVITY_ORDER[config.network_block_at];
	return sessionOrder >= blockOrder;
}

/** Check if session has exceeded its step limit */
export function isStepLimitExceeded(session: SessionTrajectory): boolean {
	return session.tool_call_count > session.step_limit;
}

/** Get step budget warning if approaching the limit. Returns null if no warning needed. */
export function getStepBudgetWarning(session: SessionTrajectory): string | null {
	if (session.step_limit === Number.POSITIVE_INFINITY) return null;
	const pct = session.tool_call_count / session.step_limit;
	const remaining = session.step_limit - session.tool_call_count;
	if (pct >= 0.95) {
		return `[interlinked:budget] CRITICAL: ${remaining} steps remaining (${Math.round(pct * 100)}% of ${session.step_limit} limit at ${session.sensitivity_level} sensitivity). Wrap up current work and commit.`;
	}
	if (pct >= 0.8) {
		return `[interlinked:budget] WARNING: ${remaining} steps remaining (${Math.round(pct * 100)}% of ${session.step_limit} limit at ${session.sensitivity_level} sensitivity). Prioritize remaining work.`;
	}
	return null;
}

/** Format taint sources for display in block/warning messages */
export function formatTaintSources(session: SessionTrajectory): string {
	if (session.taint_sources.length === 0) return "unknown";
	return session.taint_sources
		.map((s) => s.file)
		.slice(-3) // Show last 3 sources
		.join(", ");
}

// ===========================================
// Simple Glob Match (for sensitivity patterns)
// ===========================================

function sensitivityGlobMatch(filePath: string, pattern: string): boolean {
	if (filePath === pattern) return true;

	// "**/*.ext" or "**/*.ext*"
	if (pattern.startsWith("**/")) {
		const rest = pattern.slice(3);
		if (rest.startsWith("*.")) {
			const suffix = rest.slice(1);
			if (suffix.endsWith("*")) {
				return filePath.includes(suffix.slice(0, -1));
			}
			return filePath.endsWith(suffix);
		}
		// "**/.ssh/id_*" — match path ending with prefix
		if (rest.includes("*")) {
			const prefix = rest.replaceAll("*", "");
			return filePath.includes(prefix);
		}
		return filePath.endsWith(`/${rest}`) || filePath === rest;
	}

	return false;
}
