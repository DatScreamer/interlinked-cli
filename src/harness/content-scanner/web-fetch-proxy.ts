// ===========================================
// Content Scanner — WebFetch proxy (3-way human review)
// ===========================================
//
// PostToolUse `decision: "block"` does NOT replace the agent's view of
// `tool_response` — Claude Code shows the reason alongside the original
// content. To actually substitute what the model sees we have to intercept
// at PreToolUse, where `decision: "block"` short-circuits the tool entirely
// and the `reason` becomes the agent's view of the result. This file is the
// proxy that does the substitution for WebFetch:
//
//   1. Look up a prior decision file keyed on (url, prompt). If present,
//      consume it and return the corresponding variant (allow / redact /
//      block). The agent sees the chosen content as the tool result.
//
//   2. Otherwise, perform the fetch ourselves, run the body through the
//      scanner, then through the allowlist (closing the FP gap from
//      73e1c1f), and branch on whether anything survived:
//
//      - 0 surviving findings → `passthrough` with the raw body (no review
//        UI, no friction; the body becomes the tool result).
//      - >0 findings → write a review record under
//        `.interlinked/scanner/pending/<key>.review.json` and return
//        `review_pending` so the caller emits a "run interlinked scanner
//        review, then re-invoke" message to the agent. The user reviews
//        out-of-band (no hook-timeout pressure) and writes a decision file;
//        the next invocation of the same WebFetch lands in path 1.
//
//   3. On any fetch error (network, non-2xx, abort), return `fail_open` so
//      the caller falls through to the normal flow rather than wedging the
//      agent on a transient failure.
//
// Buffer cap: bodies are truncated to `config.max_scan_bytes` (default
// 100 KB). Larger pages take a tail-of-page hit, but the alternative is
// blowing up the agent's context window with megabyte-sized fetches.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { applyAllowlist, type CompiledEntry } from "./allowlist.js";
import {
	cacheKey,
	consumeDecision,
	readDecision,
	readReview,
	writeReview,
} from "./review-files.js";
import type { ContentScanner, ContentScannerConfig, ScanFinding } from "./types.js";

/** WebFetch can pull megabytes; cap the network wait at 30 s to keep the
 *  hook well under Claude Code's 5 s PreToolUse budget when the harness is
 *  acting as the agent's substitute fetcher. The harness is allowed to take
 *  longer than the hook because the proxy returns block-and-answer (the
 *  hook reply IS the tool's result) rather than awaiting a separate tool. */
const FETCH_TIMEOUT_MS = 30_000;
/** Fallback when the config doesn't specify a scan timeout. Mirrors
 *  `runPostToolScan`'s default so behaviour stays consistent across paths. */
const DEFAULT_SCAN_TIMEOUT_MS = 1500;
/** `Accept: text/markdown` opts into Cloudflare's Markdown for Agents
 *  conversion (project convention) — ~80% fewer tokens for HTML pages and
 *  the response includes an `x-markdown-tokens` count. Servers that don't
 *  support content negotiation just ignore it. */
const FETCH_HEADERS = { Accept: "text/markdown" } as const;
/** Cap manual redirect follows. Five matches Chrome / curl-default-style
 *  behaviour and is enough for normal web use without giving an attacker
 *  unbounded hop chains to confuse the per-hop SSRF re-validation. */
const MAX_REDIRECT_HOPS = 5;
/** Schemes other than these go straight to a fail_open. `file://`,
 *  `javascript:`, `gopher://`, and `data://` are not network fetches we
 *  want the harness performing on the agent's behalf. */
const ALLOWED_FETCH_SCHEMES = new Set(["http:", "https:"]);

// ===========================================
// Result shape
// ===========================================

export type ProxyResult =
	| { kind: "passthrough"; body: string }
	| { kind: "review_pending"; reviewPath: string; key: string; findingCount: number }
	| { kind: "decision_resolved"; decision: "allow" | "redact" | "block"; body: string }
	| { kind: "fail_open"; detail: string };

export interface FetchAndScanArgs {
	cwd: string;
	url: string;
	prompt: string;
	scanner: ContentScanner;
	compiledAllowlist: CompiledEntry[];
	config: ContentScannerConfig;
	toolName: string;
}

// ===========================================
// Public entry point
// ===========================================

export async function fetchAndScan(args: FetchAndScanArgs): Promise<ProxyResult> {
	const key = cacheKey(args.url, args.prompt);

	// Path 1: existing user decision short-circuits the fetch entirely.
	const decision = readDecision(args.cwd, key);
	if (decision) {
		const result = applyDecision(args.cwd, key, decision.decision);
		// Always consume the decision after applying it — otherwise repeated
		// WebFetches with the same URL silently reuse the verdict, which is
		// surprising and lets a stale "allow" leak fresh PII.
		consumeDecision(args.cwd, key);
		return result;
	}

	// Path 2: do the fetch ourselves, scan the body.
	let body: string;
	try {
		body = await fetchBody(args.url);
	} catch (fetchErr) {
		return {
			kind: "fail_open",
			detail: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
		};
	}

	const cap = args.config.max_scan_bytes || 100_000;
	const scanText = body.slice(0, cap);
	let findings: ScanFinding[];
	try {
		findings = await args.scanner.scan({
			text: scanText,
			source: `${args.toolName}.tool_response`,
			signal: AbortSignal.timeout(args.config.local.scan_timeout_ms || DEFAULT_SCAN_TIMEOUT_MS),
		});
	} catch (scanErr) {
		// Scanner unavailable — be conservative and fall through. The agent
		// will retry through the normal flow; existing rules still apply.
		const detail = scanErr instanceof Error ? scanErr.message : String(scanErr);
		return { kind: "fail_open", detail };
	}

	// Allowlist pass — drops known false positives (`noreply@*`, RFC-2606
	// test domains, snake_case identifiers, UUIDs) before they trigger a
	// review prompt. Closes the gap left by 73e1c1f, which only wired the
	// allowlist into the PreToolUse Write/Edit/Bash path.
	const surviving = applyAllowlist(findings, args.compiledAllowlist).kept;

	if (surviving.length === 0) {
		return { kind: "passthrough", body };
	}

	// Stash a review record for the user to inspect via the CLI.
	const redactedBody = redactBody(body, surviving);
	const reviewPath = writeReview({
		cwd: args.cwd,
		key,
		url: args.url,
		prompt: args.prompt,
		toolName: args.toolName,
		body,
		redactedBody,
		findings: surviving,
	});

	return {
		kind: "review_pending",
		reviewPath: reviewPath ?? `<${key}.review.json>`,
		key,
		findingCount: surviving.length,
	};
}

// ===========================================
// Decision application
// ===========================================

function applyDecision(
	cwd: string,
	key: string,
	decision: "allow" | "redact" | "block",
): ProxyResult {
	// We need the cached body + findings the user reviewed; otherwise an
	// `allow` would have nothing to return. The decision-file flow always
	// writes a review file before letting the user choose, so a missing
	// review here means the file was tampered with — fall through to
	// fail_open in that case.
	const review = readReview(cwd, key);
	if (!review) {
		return {
			kind: "fail_open",
			detail: `decision file present but review payload missing for key ${key}`,
		};
	}
	switch (decision) {
		case "allow":
			return { kind: "decision_resolved", decision, body: review.body };
		case "redact":
			return { kind: "decision_resolved", decision, body: review.redacted_body };
		case "block":
			return {
				kind: "decision_resolved",
				decision,
				body:
					"Privacy filter — response withheld by user.\n" +
					`Detected categories: ${formatCategories(review.findings)}.\n` +
					"To override, run `interlinked scanner review` and choose Allow.",
			};
	}
}

function formatCategories(findings: ScanFinding[]): string {
	const counts = new Map<string, number>();
	for (const f of findings) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([label, n]) => `${label}(${n})`)
		.join(", ");
}

// ===========================================
// Redaction (full body, not the truncated preview)
// ===========================================

/** Splice every detected span out of the body, replacing it with
 *  `<LABEL>`. Unlike `redact-preview.buildRedactedPreview`, this does NOT
 *  truncate — the agent needs the full structure of the response to do its
 *  job, just with the PII values removed. Splicing from the end keeps
 *  earlier indices valid during iteration. */
function redactBody(body: string, spans: ScanFinding[]): string {
	if (spans.length === 0) return body;
	const sorted = [...spans].sort((a, b) => b.start - a.start);
	let result = body;
	for (const span of sorted) {
		const placeholder = `<${span.label.toUpperCase()}>`;
		result = result.slice(0, span.start) + placeholder + result.slice(span.end);
	}
	return result;
}

// ===========================================
// Fetch — SSRF-guarded
// ===========================================
//
// The harness performs the WebFetch on the developer's behalf, so an
// agent-supplied URL would otherwise reach loopback / RFC1918 / link-local
// addresses the agent itself can't reach (cloud metadata at
// 169.254.169.254, dev-only services on localhost, intranet apps over
// VPN, …). Every fetch goes through `assertSafeFetchTarget` before the
// network call, and redirects are followed manually with the same
// validation re-applied to each hop.

/** Resolver shape used by `assertSafeFetchTarget`. Defaults to
 *  `dns/promises.lookup`; tests inject a deterministic stub. */
export type HostResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: HostResolver = async (hostname) => {
	const results = await dnsLookup(hostname, { all: true });
	return results.map((r) => ({ address: r.address, family: r.family }));
};

/** Reasons `assertSafeFetchTarget` rejects a URL. Exported so callers and
 *  tests can branch on a stable set of strings instead of substring-
 *  matching error messages. */
export type SsrfRejectionReason =
	| "invalid_url"
	| "scheme_not_allowed"
	| "ip_literal_blocked"
	| "hostname_resolution_failed"
	| "resolved_ip_blocked";

export class SsrfBlockedError extends Error {
	readonly reason: SsrfRejectionReason;
	readonly url: string;
	constructor(reason: SsrfRejectionReason, url: string, detail: string) {
		super(`SSRF guard blocked WebFetch (${reason}): ${detail}`);
		this.reason = reason;
		this.url = url;
		this.name = "SsrfBlockedError";
	}
}

/** True for any IPv4/IPv6 address that should never be reached by the
 *  proxy: loopback, RFC1918 private, link-local (incl. cloud-metadata
 *  169.254.169.254), broadcast/wildcard, multicast, and ULA/site-local
 *  IPv6. Operates on the canonical string form returned by
 *  `dns.lookup` — no parsing back into octets needed for the V4 ranges
 *  we care about. */
export function isBlockedAddress(addr: string): boolean {
	const family = isIP(addr);
	if (family === 4) return isBlockedV4(addr);
	if (family === 6) return isBlockedV6(addr);
	return true;
}

function isBlockedV4(addr: string): boolean {
	const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
	const [a, b] = parts;
	if (a === 0) return true; // 0.0.0.0/8 — wildcard / "this network"
	if (a === 10) return true; // RFC1918
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
	if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true; // RFC1918
	if (a === 192 && b === 168) return true; // RFC1918
	if (a === 192 && b === 0 && parts[2] === 0) return true; // RFC5736 / RFC6890
	if (a === 198 && b !== undefined && (b === 18 || b === 19)) return true; // RFC2544 benchmark
	if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + 255.255.255.255
	return false;
}

function isBlockedV6(addrRaw: string): boolean {
	// Strip a zone-id suffix if any (`fe80::1%eth0` → `fe80::1`).
	const addr = addrRaw.split("%")[0]?.toLowerCase() ?? "";
	if (addr === "::" || addr === "::1") return true;
	// IPv4-mapped (::ffff:a.b.c.d) → re-check against the V4 ranges.
	if (addr.startsWith("::ffff:")) {
		const v4 = addr.slice("::ffff:".length);
		if (isIP(v4) === 4) return isBlockedV4(v4);
	}
	// fc00::/7 (unique-local) and fe80::/10 (link-local).
	const firstSegment = Number.parseInt(addr.split(":")[0] ?? "", 16);
	if (Number.isNaN(firstSegment)) return true;
	if ((firstSegment & 0xfe00) === 0xfc00) return true; // fc00::/7
	if ((firstSegment & 0xffc0) === 0xfe80) return true; // fe80::/10
	if ((firstSegment & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	return false;
}

/** Validates a URL is safe for the harness to fetch. Throws
 *  `SsrfBlockedError` if not. Resolves hostnames via `dnsLookup` (or the
 *  injected resolver) and rejects if **any** resolved address is blocked
 *  (defends against DNS records that include a public + a private IP). */
export async function assertSafeFetchTarget(
	rawUrl: string,
	resolver: HostResolver = defaultResolver,
): Promise<URL> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch (_err) {
		throw new SsrfBlockedError("invalid_url", rawUrl, "URL parse failed");
	}
	if (!ALLOWED_FETCH_SCHEMES.has(parsed.protocol)) {
		throw new SsrfBlockedError(
			"scheme_not_allowed",
			rawUrl,
			`scheme ${parsed.protocol} not in {http, https}`,
		);
	}
	const hostname = parsed.hostname;
	if (!hostname) {
		throw new SsrfBlockedError("invalid_url", rawUrl, "URL has no hostname");
	}
	// Strip surrounding brackets that `URL.hostname` keeps for IPv6
	// literals (`[::1]` → `::1`).
	const bareHost = hostname.startsWith("[") && hostname.endsWith("]")
		? hostname.slice(1, -1)
		: hostname;
	if (isIP(bareHost) !== 0) {
		// Literal IP — no DNS rebinding window, just range-check it.
		if (isBlockedAddress(bareHost)) {
			throw new SsrfBlockedError(
				"ip_literal_blocked",
				rawUrl,
				`literal address ${bareHost} is private/loopback/link-local`,
			);
		}
		return parsed;
	}
	// Hostname — resolve and reject if any A/AAAA is blocked.
	let addresses: { address: string; family: number }[];
	try {
		addresses = await resolver(bareHost);
	} catch (err) {
		throw new SsrfBlockedError(
			"hostname_resolution_failed",
			rawUrl,
			`DNS lookup of ${bareHost} failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (addresses.length === 0) {
		throw new SsrfBlockedError(
			"hostname_resolution_failed",
			rawUrl,
			`DNS lookup of ${bareHost} returned no addresses`,
		);
	}
	for (const entry of addresses) {
		if (isBlockedAddress(entry.address)) {
			throw new SsrfBlockedError(
				"resolved_ip_blocked",
				rawUrl,
				`hostname ${bareHost} resolves to blocked address ${entry.address}`,
			);
		}
	}
	return parsed;
}

/** Throws on any non-success outcome (network error, abort, non-2xx
 *  status, decode failure, SSRF rejection on any hop). The caller wraps
 *  the call in try/catch and surfaces `fail_open` — keeping the success
 *  path linear here. Redirects are followed manually with the same SSRF
 *  validation applied to every hop, which closes the public-URL-302-to-
 *  private-host bypass. */
async function fetchBody(url: string): Promise<string> {
	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
		await assertSafeFetchTarget(currentUrl);
		const response = await fetch(currentUrl, {
			headers: FETCH_HEADERS,
			redirect: "manual",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers?.get?.("Location");
			if (!location) {
				throw new Error(`HTTP ${response.status} redirect without Location header`);
			}
			// Resolve relative redirects against the current URL.
			currentUrl = new URL(location, currentUrl).toString();
			continue;
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return await response.text();
	}
	throw new Error(`exceeded ${MAX_REDIRECT_HOPS} redirect hops`);
}
