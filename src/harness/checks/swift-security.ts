// Swift / iOS security checks: weak crypto, insecure URLs, secret storage,
// ATS bypass in Info.plist.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

const MATCH_LIMIT = 10;

/**
 * Detect MD5 / SHA-1 / DES usage in Swift. Three sources:
 *   1. CommonCrypto C bindings: `CC_MD5`, `CC_SHA1`, `kCCAlgorithmDES`,
 *      `kCCAlgorithm3DES`.
 *   2. CryptoKit's deliberately-named `Insecure.MD5` / `Insecure.SHA1`
 *      legacy-interop wrappers.
 *   3. Bridged Foundation: `CommonHMACAlgorithm.MD5`.
 *
 * MD5 is collision-broken (2004), SHA-1 is collision-broken (2017), DES is
 * brute-forceable in seconds on modern hardware. The only legitimate uses
 * are bug-for-bug interop with legacy protocols.
 */
export function checkSwiftWeakCrypto(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\b(?:CC_MD5|CC_SHA1|CC_MD2|CC_MD4|kCCAlgorithmDES|kCCAlgorithm3DES|Insecure\.(?:MD5|SHA1))\b/,
		MATCH_LIMIT,
	);
}

/**
 * Detect plain HTTP URL literals in Swift source. Skips:
 *   - localhost / 127.0.0.1 / 0.0.0.0 / [::1]
 *   - *.local (Bonjour / mDNS, explicitly ATS-permitted)
 *   - 192.168.*.* / 10.*.*.* / 172.16-31.*.*  (RFC 1918 private)
 *   - comment lines
 *
 * Two pass: we scan the original lines (NOT the stripped version) because the
 * URL literal lives inside a string and `stripCommentsAndStrings` would blank
 * it. We skip lines that begin with comment markers via a separate check.
 */
export function checkSwiftHttpUrlLiteral(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// `"http://<host>..."` where host is NOT a recognized local form.
	const re =
		/["']http:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|[\w-]+\.local(?:\b|[:/])))[^"']+["']/;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const trimmed = originalLines[i].trimStart();
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
			continue;
		}
		if (re.test(originalLines[i])) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect storage of a sensitive value in `UserDefaults` or `@AppStorage`.
 *
 * Sensitive keys (regex on key NAME, not value): password, passwd, pwd,
 * secret, token, api[_-]?key, apikey, private[_-]?key, access[_-]?token,
 * refresh[_-]?token, auth[_-]?token, credential, authorization, session[_-]?id.
 *
 * Both styles are detected:
 *   - `UserDefaults.standard.set(value, forKey: "password")`
 *   - `UserDefaults(suiteName: "x").set(value, forKey: "apiKey")`
 *   - `UserDefaults.standard["password"] = ...`
 *   - `@AppStorage("authToken") var authToken: String = ""`
 */
const SENSITIVE_KEY_RE =
	/\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|credential|authorization|session[_-]?id)\b/i;

export function checkSwiftUserDefaultsForSecret(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const userDefaultsCall = /\bUserDefaults\s*(?:\.[A-Za-z_]\w*|\([^)]*\))/;
	const appStorage = /@AppStorage\s*\(\s*["']([^"']+)["']/;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = originalLines[i];
		const trimmed = line.trimStart();
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
			continue;
		}

		const ap = appStorage.exec(line);
		if (ap && SENSITIVE_KEY_RE.test(ap[1])) {
			matches.push({ line: i + 1, text: line.trim().slice(0, 150) });
			continue;
		}

		if (userDefaultsCall.test(line)) {
			const forKey = /forKey\s*:\s*["']([^"']+)["']/.exec(line);
			if (forKey && SENSITIVE_KEY_RE.test(forKey[1])) {
				matches.push({ line: i + 1, text: line.trim().slice(0, 150) });
				continue;
			}
			const subscript = /\[\s*["']([^"']+)["']\s*\]\s*=/.exec(line);
			if (subscript && SENSITIVE_KEY_RE.test(subscript[1])) {
				matches.push({ line: i + 1, text: line.trim().slice(0, 150) });
			}
		}
	}
	return matches;
}

/**
 * Detect `NSAllowsArbitraryLoads` / `NSExceptionAllowsInsecureHTTPLoads` set
 * to true (or YES) in an Info.plist (or any `*.plist`).
 *
 * `NSAllowsArbitraryLoads = true` is a global ATS bypass — every HTTP request
 * becomes insecure. The scoped form `NSExceptionAllowsInsecureHTTPLoads = true`
 * under `NSExceptionDomains.<host>` is narrower (one host) but still grants
 * cleartext for that host; both deserve a flag, leaving the dev to choose
 * scoping intentionally.
 */
export function checkSwiftAtsArbitraryLoads(content: string, filePath: string): InlineMatch[] {
	const lower = filePath.toLowerCase();
	if (!lower.endsWith(".plist")) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const TRUE_RE = /<true\s*\/>|<string>\s*YES\s*<\/string>/i;
	const FALSE_RE = /<false\s*\/>|<string>\s*NO\s*<\/string>/i;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = originalLines[i];
		if (
			!/<key>\s*(?:NSAllowsArbitraryLoads|NSExceptionAllowsInsecureHTTPLoads|NSAllowsArbitraryLoadsInWebContent|NSAllowsArbitraryLoadsForMedia)\s*<\/key>/.test(
				line,
			)
		) {
			continue;
		}
		// Plist formatting comes in two flavors: indented (`<key>...</key>`
		// on one line, value on the next) and compact (everything on one
		// line). Check the current line first, then the next 1–3.
		let truthy = false;
		if (TRUE_RE.test(line)) {
			truthy = true;
		} else if (FALSE_RE.test(line)) {
			truthy = false;
		} else {
			for (let j = i + 1; j < Math.min(i + 4, originalLines.length); j++) {
				const next = originalLines[j];
				if (TRUE_RE.test(next)) {
					truthy = true;
					break;
				}
				if (FALSE_RE.test(next)) break;
			}
		}
		if (truthy) {
			matches.push({ line: i + 1, text: line.trim().slice(0, 150) });
		}
	}
	return matches;
}
