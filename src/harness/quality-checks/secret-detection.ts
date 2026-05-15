// ===========================================
// Secret Detection (inline, for secrets_in_source check)
// ===========================================
// Regex patterns that match common secret formats (AWS, GitHub tokens, JWT,
// private keys, Slack, Stripe, SendGrid, npm). Extracted from quality-checks.ts
// so the pre-edit hook and docs generator can reference them directly.
//
// Each regex match is confirmed with a Shannon-entropy floor before it counts
// as a secret. A genuine credential has a random body that scores well above
// 3 bits; filler strings (`sk_test_0000…`, an `AKIA` prefix followed by
// repeated characters) score near zero. The floor sits in the empty valley
// between the two, so it suppresses the dominant false-positive class —
// example and filler secrets in docs, `.env.example` files, and test
// fixtures — without risking a missed match on a real high-entropy key.
// Technique borrowed from narsil-mcp's `calculate_entropy` secret gate
// (see docs/external-pulse/narsil-mcp.md).

/**
 * Shannon-entropy floor (bits) a regex match must clear to count as a secret.
 *
 * Calibrated so the AWS canonical example key — a 20-character `AKIA`-prefixed
 * string scoring ≈3.68 bits, the lowest-entropy value still worth flagging —
 * clears it with margin. Filler bodies (an `AKIA` prefix plus 16 repeated
 * characters ≈ 1.0 bits) land far below. Real credentials have random bodies
 * and score higher still, so the floor carries no missed-match risk.
 */
const SECRET_ENTROPY_FLOOR = 3.0;

interface SecretPattern {
	/**
	 * Human-readable kind. Callers surface only this label, never the matched
	 * value. Must contain the format's signature substring — `containsSecrets`
	 * consumers and tests match on it (e.g. a label containing "AKIA").
	 */
	label: string;
	/**
	 * Match pattern. Carries the `g` flag so `matchAll` scans every occurrence
	 * — a low-entropy filler match early in a file must not mask a real secret
	 * of the same shape later on.
	 */
	pattern: RegExp;
	/**
	 * When set, any match is reported regardless of entropy. Reserved for
	 * structural markers (PEM headers) that are definitive on shape alone and
	 * carry no random body to score.
	 */
	alwaysReport?: boolean;
}

const SECRET_PATTERNS: SecretPattern[] = [
	{ label: "AKIA AWS access key", pattern: /AKIA[0-9A-Z]{16}/g },
	{ label: "ghp/ghs GitHub token", pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g },
	{ label: "github_pat GitHub PAT", pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
	{
		label: "eyJ JWT",
		pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
	},
	{
		label: "-----BEGIN private key",
		pattern: /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
		alwaysReport: true,
	},
	{ label: "xox Slack token", pattern: /xox[bpors]-[A-Za-z0-9-]{10,}/g },
	{
		label: "sk/pk Stripe key",
		pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g,
	},
	{
		label: "SG SendGrid key",
		pattern: /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}/g,
	},
	{ label: "npm npm token", pattern: /npm_[A-Za-z0-9]{36,}/g },
];

/**
 * Shannon entropy of a string, in bits.
 *
 * H = −Σ p(c)·log2 p(c) over the distinct characters c. A uniformly random
 * string approaches log2(alphabet size); a single-repeated-character string
 * scores 0. Used as a confirmer on regex matches so filler secrets
 * (`sk_test_0000…`) are separated from genuine credentials.
 */
function shannonEntropy(s: string): number {
	const freq = new Map<string, number>();
	let total = 0;
	for (const ch of s) {
		freq.set(ch, (freq.get(ch) ?? 0) + 1);
		total++;
	}
	if (total === 0) return 0;
	let h = 0;
	for (const count of freq.values()) {
		// total > 0 here — the total === 0 case returned above.
		const p = count / total;
		h -= p * Math.log2(p);
	}
	return h;
}

/**
 * Public API — consumed by quality-checks.runQualityChecks and the PreToolUse
 * evaluator's content scan.
 *
 * Return a label for each secret-pattern with at least one occurrence that
 * clears the entropy floor, or an empty array when nothing matched. Callers
 * only need the count/kind — the raw secret value is intentionally not
 * returned.
 */
export function containsSecrets(content: string): string[] {
	const found: string[] = [];
	for (const { label, pattern, alwaysReport } of SECRET_PATTERNS) {
		for (const match of content.matchAll(pattern)) {
			if (alwaysReport || shannonEntropy(match[0]) >= SECRET_ENTROPY_FLOOR) {
				found.push(label);
				break;
			}
		}
	}
	return found;
}
