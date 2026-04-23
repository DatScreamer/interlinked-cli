// ===========================================
// Secret Detection (inline, for secrets_in_source check)
// ===========================================
// Regex patterns that match common secret formats (AWS, GitHub tokens, JWT,
// private keys, Slack, Stripe, SendGrid, npm). Extracted from quality-checks.ts
// so the pre-edit hook and docs generator can reference them directly.

const SECRET_PATTERNS = [
	/AKIA[0-9A-Z]{16}/,
	/gh[ps]_[A-Za-z0-9_]{36,}/,
	/github_pat_[A-Za-z0-9_]{22,}/,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
	/-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
	/xox[bpors]-[A-Za-z0-9-]{10,}/,
	/(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/,
	/SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}/,
	/npm_[A-Za-z0-9]{36,}/,
];

/**
 * Public API — consumed by quality-checks.runQualityChecks and the PreToolUse
 * evaluator's content scan.
 *
 * Return the prefix of each secret-pattern that matched the given content, or
 * an empty array when nothing matched. Callers only need the count/kind — the
 * raw secret value is intentionally not returned.
 */
export function containsSecrets(content: string): string[] {
	const found: string[] = [];
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(content)) {
			found.push(`${pattern.source.slice(0, 20)}...`);
		}
	}
	return found;
}
