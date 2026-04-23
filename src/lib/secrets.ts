// ===========================================
// Secret Detection & Scrubbing
// ===========================================
// Dual-layer detection: pattern matching + Shannon entropy.
// Used in hook scripts (patterns only) and pre-sync gate (full).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";

// ===========================================
// Types
// ===========================================

interface ScrubResult {
	text: string;
	found: number;
	types: string[];
}

interface ScrubConfig {
	enabled?: boolean;
	extra_patterns?: string[];
	ignore_patterns?: string[];
	entropy_threshold?: number;
	entropy_min_length?: number;
}

// ===========================================
// Patterns
// ===========================================

interface SecretPattern {
	name: string;
	regex: RegExp;
}

const BUILTIN_PATTERNS: SecretPattern[] = [
	{ name: "aws_key", regex: /AKIA[0-9A-Z]{16}/g },
	{
		name: "aws_secret",
		regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/g,
	},
	{ name: "github_token", regex: /gh[ps]_[A-Za-z0-9_]{36,}/g },
	{ name: "github_pat", regex: /github_pat_[A-Za-z0-9_]{22,}/g },
	{ name: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
	{ name: "private_key", regex: /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
	{
		name: "connection_string",
		regex: /(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s"']{10,}/g,
	},
	{
		name: "generic_secret",
		regex: /(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+]{16,}["']?/gi,
	},
	{ name: "slack_token", regex: /xox[bpors]-[A-Za-z0-9-]{10,}/g },
	{ name: "stripe_key", regex: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
	{ name: "sendgrid_key", regex: /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}/g },
	{ name: "npm_token", regex: /npm_[A-Za-z0-9]{36,}/g },
];

// ===========================================
// Shannon Entropy
// ===========================================

function shannonEntropy(str: string): number {
	if (str.length === 0) return 0;

	const freq = new Map<string, number>();
	for (const char of str) {
		freq.set(char, (freq.get(char) || 0) + 1);
	}

	let entropy = 0;
	const len = str.length;
	for (const count of freq.values()) {
		const p = count / len;
		entropy -= p * Math.log2(p);
	}

	return entropy;
}

// Common patterns that look high-entropy but aren't secrets
const ENTROPY_ALLOW_LIST = [
	/^[A-Za-z0-9+/]+=*$/, // base64 padding (common in hashes)
	/^\d+\.\d+\.\d+/, // version numbers
	/^[a-f0-9]{32,}$/, // hex hashes (md5, sha256)
	/^[A-Za-z]+[A-Z][a-z]/, // camelCase identifiers
];

function isLikelySecret(token: string, threshold: number, minLength: number): boolean {
	if (token.length < minLength) return false;

	// Skip common non-secret patterns
	for (const pattern of ENTROPY_ALLOW_LIST) {
		if (pattern.test(token)) return false;
	}

	return shannonEntropy(token) > threshold;
}

// ===========================================
// Scrubbing
// ===========================================

/**
 * Load scrub config from .interlinked/scrub.json.
 */
export function loadScrubConfig(cwd?: string): ScrubConfig {
	const configPath = join(getConfigDir(cwd), "scrub.json");
	if (!existsSync(configPath)) {
		return { enabled: true };
	}
	try {
		return JSON.parse(readFileSync(configPath, "utf-8")) as ScrubConfig;
	} catch (_err) {
		/* intentional: malformed scrub.json — fall back to default-enabled config */
		return { enabled: true };
	}
}

/**
 * Scrub secrets from text using pattern matching and entropy detection.
 */
export function scrubSecrets(text: string, opts?: ScrubConfig): ScrubResult {
	if (!text) return { text, found: 0, types: [] };

	const config = opts || {};
	if (config.enabled === false) return { text, found: 0, types: [] };

	let scrubbed = text;
	const foundTypes: string[] = [];
	let found = 0;

	// Compile ignore patterns. These come from user-authored scrub.json under
	// the caller's control, not from untrusted input — dynamic RegExp is
	// deliberate here.
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	const ignorePatterns = (config.ignore_patterns || []).map((p) => new RegExp(p, "g"));

	// Check if a match should be ignored
	const shouldIgnore = (match: string) =>
		ignorePatterns.some((p) => {
			p.lastIndex = 0;
			return p.test(match);
		});

	// Layer 1: Pattern matching. `extra_patterns` is user-authored scrub
	// config, not untrusted input — dynamic RegExp is deliberate.
	const allPatterns = [...BUILTIN_PATTERNS];
	if (config.extra_patterns) {
		for (const p of config.extra_patterns) {
			try {
				// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
				allPatterns.push({ name: "custom", regex: new RegExp(p, "g") });
			} catch (_err) {
				/* intentional: user-supplied pattern failed to compile — skip it silently */
			}
		}
	}

	for (const pattern of allPatterns) {
		pattern.regex.lastIndex = 0;
		let match: RegExpExecArray | null = pattern.regex.exec(scrubbed);
		while (match !== null) {
			if (shouldIgnore(match[0])) {
				match = pattern.regex.exec(scrubbed);
				continue;
			}
			scrubbed =
				scrubbed.slice(0, match.index) +
				`[REDACTED:${pattern.name}]` +
				scrubbed.slice(match.index + match[0].length);
			if (!foundTypes.includes(pattern.name)) foundTypes.push(pattern.name);
			found++;
			// Reset lastIndex since string changed
			pattern.regex.lastIndex = match.index + `[REDACTED:${pattern.name}]`.length;
			match = pattern.regex.exec(scrubbed);
		}
	}

	// Layer 2: Entropy detection
	const threshold = config.entropy_threshold || 4.5;
	const minLength = config.entropy_min_length || 20;

	// Split on whitespace and common delimiters, check each token
	const tokens = scrubbed.split(/[\s"'`=:,;{}[\]()]+/);
	for (const token of tokens) {
		if (token.includes("[REDACTED:")) continue; // Already scrubbed
		if (isLikelySecret(token, threshold, minLength)) {
			scrubbed = scrubbed.replace(token, "[REDACTED:entropy]");
			if (!foundTypes.includes("entropy")) foundTypes.push("entropy");
			found++;
		}
	}

	return { text: scrubbed, found, types: foundTypes };
}

/**
 * Quick check if text contains any secrets.
 */
export function containsSecrets(text: string): boolean {
	if (!text) return false;
	for (const pattern of BUILTIN_PATTERNS) {
		pattern.regex.lastIndex = 0;
		if (pattern.regex.test(text)) return true;
	}
	return false;
}

// ===========================================
// Stats
// ===========================================

const scrubStats = { total_scrubbed: 0, by_type: {} as Record<string, number> };

export function recordScrub(types: string[]): void {
	scrubStats.total_scrubbed++;
	for (const t of types) {
		scrubStats.by_type[t] = (scrubStats.by_type[t] || 0) + 1;
	}
}
