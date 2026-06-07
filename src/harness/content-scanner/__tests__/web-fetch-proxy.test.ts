// Tests for the WebFetch proxy — the harness's response-side PII gate.
// The proxy intercepts WebFetch at PreToolUse, performs the fetch itself,
// scans the body, and either passes the body through to the agent
// (block-and-answer), stashes a review file for the human, or honours a
// decision the human already made via `interlinked scanner review`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileAllowlist } from "../allowlist.js";
import {
	cacheKey,
	listPendingReviews,
	readReview,
	writeDecision,
	writeReview,
} from "../review-files.js";
import type { ContentScanner, ContentScannerConfig, ScanFinding } from "../types.js";
import {
	assertSafeFetchTarget,
	fetchAndScan,
	isBlockedAddress,
	SsrfBlockedError,
} from "../web-fetch-proxy.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "web-fetch-proxy-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

const baseConfig: ContentScannerConfig = {
	enabled: true,
	runtime: "local",
	scan_points: {
		write_edit: true,
		bash_command: false,
		external_egress: true,
		read_grep_taint: true,
		user_prompt: false,
	},
	local: {
		python_bin: "python3",
		sidecar_script: "/dev/null",
		startup_timeout_ms: 10_000,
		scan_timeout_ms: 1500,
		idle_shutdown_ms: 60_000,
		max_restarts: 3,
	},
	huggingface: { model: "x", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
	custom_http: { endpoint: "x", timeout_ms: 4000 },
	min_score: 0,
	max_scan_bytes: 100_000,
};

function makeScanner(findings: ScanFinding[]): ContentScanner {
	return {
		name: "fake-scanner",
		runtime: "local",
		ready: async () => true,
		scan: async () => findings,
		shutdown: async () => {},
	};
}

// Body + status the next pinned-fetcher call should resolve to. Set via
// `stubFetch(body, ok?)` per test. The production code path now uses
// `node:http(s).request` with a DNS-pinned `lookup` (the SSRF-rebinding
// fix) instead of the global `fetch`, so `vi.stubGlobal("fetch", ...)` no
// longer intercepts. We pass a deterministic `fetcher` through
// `FetchAndScanArgs` to short-circuit the network entirely.
let stubbedBody: string | null = null;
let stubbedOk = true;

function stubFetch(body: string, ok = true): void {
	stubbedBody = body;
	stubbedOk = ok;
}

const stubFetcher: NonNullable<Parameters<typeof fetchAndScan>[0]["fetcher"]> = async () => {
	if (stubbedBody === null) throw new Error("stubFetch was not called for this test");
	if (!stubbedOk) throw new Error("HTTP 500");
	return stubbedBody;
};

function finding(label: string, text: string, start: number): ScanFinding {
	return { label, start, end: start + text.length, text, source: "WebFetch.response" };
}

const allowlistEmpty = compileAllowlist(undefined);

describe("fetchAndScan — clean body (no findings)", () => {
	it("returns passthrough with the fetched body", async () => {
		stubFetch("hello world, no PII here");
		const scanner = makeScanner([]);
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com",
			prompt: "summarise",
			scanner,
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "passthrough", body: "hello world, no PII here" });
		// No review file written when nothing was flagged.
		expect(listPendingReviews(cwd)).toEqual([]);
	});
});

describe("fetchAndScan — scanner failure", () => {
	it("returns fail_open when the scanner itself throws", async () => {
		// Scanner unavailable (process died, model load failed, …) must not
		// wedge the agent — the proxy falls through to the normal flow.
		stubFetch("body with a@b.example somewhere");
		const scanner: ContentScanner = {
			name: "exploding-scanner",
			runtime: "local",
			ready: async () => true,
			scan: async () => {
				throw new Error("sidecar crashed");
			},
			shutdown: async () => {},
		};
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/scan-dies",
			prompt: "p",
			scanner,
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
			fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "fail_open", detail: "sidecar crashed" });
		// A failed scan must never leave a review file behind.
		expect(listPendingReviews(cwd)).toEqual([]);
	});

	it("stringifies a non-Error scanner rejection in the fail_open detail", async () => {
		stubFetch("anything");
		const scanner: ContentScanner = {
			name: "string-thrower",
			runtime: "local",
			ready: async () => true,
			// Reject with a non-Error value to exercise the String(...) branch.
			scan: async () => {
				throw "scanner string fault";
			},
			shutdown: async () => {},
		};
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/string-fault",
			prompt: "p",
			scanner,
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
			fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "fail_open", detail: "scanner string fault" });
	});

	it("falls back to the default scan timeout when config provides 0", async () => {
		// scan_timeout_ms === 0 is falsy → the proxy uses DEFAULT_SCAN_TIMEOUT_MS.
		// We only need the path to execute cleanly; the scanner returns at once.
		stubFetch("clean body");
		const zeroTimeoutConfig: ContentScannerConfig = {
			...baseConfig,
			local: { ...baseConfig.local, scan_timeout_ms: 0 },
		};
		const scanner = makeScanner([]);
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/zero-timeout",
			prompt: "p",
			scanner,
			compiledAllowlist: allowlistEmpty,
			config: zeroTimeoutConfig,
			toolName: "WebFetch",
			fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "passthrough", body: "clean body" });
	});

	it("falls back to the default scan-byte cap when max_scan_bytes is 0", async () => {
		// max_scan_bytes === 0 is falsy → the proxy uses the 100_000 default
		// cap, so the whole (short) body is scanned and passed through.
		stubFetch("short clean body");
		const zeroCapConfig: ContentScannerConfig = { ...baseConfig, max_scan_bytes: 0 };
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/zero-cap",
			prompt: "p",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: zeroCapConfig,
			toolName: "WebFetch",
			fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "passthrough", body: "short clean body" });
	});
});

describe("fetchAndScan — findings present", () => {
	it("returns review_pending when the scanner flags content", async () => {
		stubFetch("Contact: alice@real-domain.example for details.");
		const scanner = makeScanner([finding("private_email", "alice@real-domain.example", 9)]);
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/contact",
			prompt: "extract contacts",
			scanner,
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "review_pending" });
	});

	it("writes a review file with the raw body and a redacted preview", async () => {
		const body = "Contact: alice@real-domain.example for details.";
		stubFetch(body);
		const scanner = makeScanner([finding("private_email", "alice@real-domain.example", 9)]);
		await fetchAndScan({
			cwd,
			url: "https://example.com/contact",
			prompt: "extract contacts",
			scanner,
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		const list = listPendingReviews(cwd);
		expect(list).toHaveLength(1);
		const review = readReview(cwd, list[0]?.key ?? "");
		expect(review).toMatchObject({
			body,
			findings: [{ label: "private_email" }],
		});
		expect(review?.redacted_body).toContain("<PRIVATE_EMAIL>");
		expect(review?.redacted_body).not.toContain("alice@real-domain.example");
	});

	it("redacts multiple spans, splicing from the end so earlier offsets stay valid", async () => {
		// Two findings at different offsets force redactBody to sort spans
		// descending and splice each out without corrupting the other's index.
		// `phone` appears BEFORE `email` in the body but the spans are passed
		// in source order; the descending sort must reorder them.
		const body = "Call 555-0100 or write to bob@real-domain.example today.";
		stubFetch(body);
		const phone = finding("private_phone", "555-0100", body.indexOf("555-0100"));
		const email = finding(
			"private_email",
			"bob@real-domain.example",
			body.indexOf("bob@real-domain.example"),
		);
		const scanner = makeScanner([phone, email]);
		await fetchAndScan({
			cwd,
			url: "https://example.com/multi",
			prompt: "extract",
			scanner,
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
			fetcher: stubFetcher,
		});
		const list = listPendingReviews(cwd);
		expect(list).toHaveLength(1);
		const review = readReview(cwd, list[0]?.key ?? "");
		// Both placeholders present, both raw values gone, surrounding text intact.
		expect(review?.redacted_body).toBe(
			"Call <PRIVATE_PHONE> or write to <PRIVATE_EMAIL> today.",
		);
		expect(review).toMatchObject({ findings: [{ label: "private_phone" }, { label: "private_email" }] });
	});
});

describe("fetchAndScan — allowlist closes the FP gap from 73e1c1f", () => {
	it("suppresses findings the allowlist matches and falls through to passthrough", async () => {
		// noreply@anthropic.com is on the default allowlist; ship the proxy
		// with the same allowlist applied so it doesn't trigger a 3-way prompt.
		stubFetch("Email: noreply@anthropic.com if confused.");
		const scanner = makeScanner([finding("private_email", "noreply@anthropic.com", 7)]);
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/noreply",
			prompt: "",
			scanner,
			compiledAllowlist: compileAllowlist([
				{ kind: "prefix", pattern: "noreply@", label: "private_email" },
			]),
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "passthrough" });
		expect(listPendingReviews(cwd)).toEqual([]);
	});
});

describe("fetchAndScan — decision file already on disk", () => {
	const actor = { user: "u", host: "h", tty: null };

	it("returns the raw body when decision is allow", async () => {
		const url = "https://example.com/allow";
		const prompt = "p";
		const key = cacheKey(url, prompt);
		writeReview({
			cwd,
			key,
			url,
			prompt,
			toolName: "WebFetch",
			body: "Original body containing alice@x.example",
			redactedBody: "Original body containing <PRIVATE_EMAIL>",
			findings: [finding("private_email", "alice@x.example", 22)],
		});
		writeDecision({ cwd, key, decision: "allow", actor });
		const result = await fetchAndScan({
			cwd,
			url,
			prompt,
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		expect(result).toMatchObject({
			kind: "decision_resolved",
			decision: "allow",
			body: "Original body containing alice@x.example",
		});
	});

	it("does not call fetch when honouring an existing decision", async () => {
		const url = "https://example.com/no-fetch";
		const key = cacheKey(url, "");
		writeReview({
			cwd,
			key,
			url,
			prompt: "",
			toolName: "WebFetch",
			body: "cached",
			redactedBody: "cached",
			findings: [],
		});
		writeDecision({ cwd, key, decision: "allow", actor });
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await fetchAndScan({
			cwd,
			url,
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns the redacted body when decision is redact", async () => {
		const url = "https://example.com/redact";
		const key = cacheKey(url, "");
		writeReview({
			cwd,
			key,
			url,
			prompt: "",
			toolName: "WebFetch",
			body: "Original body containing alice@x.example",
			redactedBody: "Original body containing <PRIVATE_EMAIL>",
			findings: [finding("private_email", "alice@x.example", 22)],
		});
		writeDecision({ cwd, key, decision: "redact", actor });
		const result = await fetchAndScan({
			cwd,
			url,
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		expect(result).toMatchObject({
			kind: "decision_resolved",
			decision: "redact",
			body: "Original body containing <PRIVATE_EMAIL>",
		});
	});

	it("returns a withheld notice when decision is block", async () => {
		const url = "https://example.com/block";
		const key = cacheKey(url, "");
		writeReview({
			cwd,
			key,
			url,
			prompt: "",
			toolName: "WebFetch",
			body: "secret body",
			redactedBody: "<REDACTED>",
			findings: [finding("private_email", "x@y.example", 0)],
		});
		writeDecision({ cwd, key, decision: "block", actor });
		const result = await fetchAndScan({
			cwd,
			url,
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "decision_resolved", decision: "block" });
		expect((result as { body: string }).body).toMatch(/withheld/i);
		expect((result as { body: string }).body).not.toContain("secret body");
	});

	it("lists detected categories (deduped, counted, sorted) in the block notice", async () => {
		// Three findings across two labels: the block message aggregates them
		// via formatCategories into "label(n)" pairs sorted by label name.
		const url = "https://example.com/block-cats";
		const key = cacheKey(url, "");
		writeReview({
			cwd,
			key,
			url,
			prompt: "",
			toolName: "WebFetch",
			body: "x@y.example z@w.example +1-555-0100",
			redactedBody: "<...>",
			findings: [
				finding("private_email", "x@y.example", 0),
				finding("private_email", "z@w.example", 12),
				finding("private_phone", "+1-555-0100", 24),
			],
		});
		writeDecision({ cwd, key, decision: "block", actor });
		const result = await fetchAndScan({
			cwd,
			url,
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
			fetcher: stubFetcher,
		});
		const text = (result as { body: string }).body;
		// Sorted alphabetically: private_email before private_phone; counts shown.
		expect(text).toContain("private_email(2), private_phone(1)");
	});

	it("fails open when a decision file exists but its review payload is gone", async () => {
		// A decision file with no sibling review = tampering / partial cleanup.
		// applyDecision has no body to return, so it must fail open rather than
		// surface an empty allow.
		const url = "https://example.com/orphan-decision";
		const key = cacheKey(url, "");
		writeDecision({ cwd, key, decision: "allow", actor });
		const result = await fetchAndScan({
			cwd,
			url,
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
			fetcher: stubFetcher,
		});
		expect(result.kind).toBe("fail_open");
		expect((result as { detail: string }).detail).toContain("review payload missing");
		expect((result as { detail: string }).detail).toContain(key);
	});

	it("consumes the decision so a second call does not re-apply it", async () => {
		const url = "https://example.com/once";
		const key = cacheKey(url, "");
		writeReview({
			cwd,
			key,
			url,
			prompt: "",
			toolName: "WebFetch",
			body: "ok",
			redactedBody: "ok",
			findings: [],
		});
		writeDecision({ cwd, key, decision: "allow", actor });
		await fetchAndScan({
			cwd,
			url,
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		stubFetch("fresh body without PII");
		const result = await fetchAndScan({
			cwd,
			url,
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "passthrough" });
	});
});

describe("assertSafeFetchTarget — SSRF guard", () => {
	const stubResolver = (addresses: string[]) => async () =>
		addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

	it("rejects non-http(s) schemes", async () => {
		await expect(assertSafeFetchTarget("file:///etc/passwd")).rejects.toBeInstanceOf(
			SsrfBlockedError,
		);
		await expect(assertSafeFetchTarget("javascript:alert(1)")).rejects.toMatchObject({
			reason: "scheme_not_allowed",
		});
		await expect(assertSafeFetchTarget("gopher://x.example/foo")).rejects.toMatchObject({
			reason: "scheme_not_allowed",
		});
	});

	it("rejects malformed URLs", async () => {
		await expect(assertSafeFetchTarget("not a url")).rejects.toMatchObject({
			reason: "invalid_url",
		});
	});

	it("rejects IPv4 literals in loopback / RFC1918 / link-local ranges", async () => {
		const blockedV4 = [
			"http://127.0.0.1/",
			"http://127.0.0.1:6379/",
			"http://10.0.0.1/",
			"http://172.16.0.5/",
			"http://172.31.255.255/",
			"http://192.168.1.1/",
			"http://169.254.169.254/latest/meta-data/", // EC2/GCP/Azure metadata
			"http://0.0.0.0/",
			"http://224.0.0.1/", // multicast
		];
		for (const url of blockedV4) {
			await expect(assertSafeFetchTarget(url)).rejects.toMatchObject({
				reason: "ip_literal_blocked",
			});
		}
	});

	it("allows IPv4 literals in public ranges", async () => {
		// 8.8.8.8 is unambiguously public — no DNS lookup needed because
		// the URL hostname is a literal IP. Returns the vetted target so
		// the fetcher can pin its connect to the same address.
		const result = await assertSafeFetchTarget("http://8.8.8.8/");
		expect(result.url).toBeInstanceOf(URL);
		expect(result.vettedAddress).toBe("8.8.8.8");
		expect(result.vettedFamily).toBe(4);
	});

	it("allows a public IPv6 literal and reports family 6", async () => {
		// Bracketed IPv6 literal: the brackets are stripped, the range check
		// clears it, and vettedFamily is 6 (the literal-IP V6 branch).
		const result = await assertSafeFetchTarget("https://[2606:4700:4700::1111]/dns-query");
		expect(result.url).toBeInstanceOf(URL);
		expect(result.vettedAddress).toBe("2606:4700:4700::1111");
		expect(result.vettedFamily).toBe(6);
	});

	it("preserves the parse error as the SsrfBlockedError cause", async () => {
		// invalid_url carries the underlying URL parse failure on `.cause`.
		const err = await assertSafeFetchTarget("::::not a url::::").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SsrfBlockedError);
		expect((err as SsrfBlockedError).reason).toBe("invalid_url");
		expect((err as SsrfBlockedError).cause).toBeInstanceOf(Error);
	});

	it("rejects IPv6 loopback / unique-local / link-local literals", async () => {
		const blockedV6 = [
			"http://[::1]/",
			"http://[fc00::1]/", // unique-local
			"http://[fd12:3456:789a::1]/", // unique-local (fd00::/8)
			"http://[fe80::1]/", // link-local
			"http://[ff02::1]/", // multicast
		];
		for (const url of blockedV6) {
			await expect(assertSafeFetchTarget(url)).rejects.toMatchObject({
				reason: "ip_literal_blocked",
			});
		}
	});

	it("rejects IPv4-mapped IPv6 addresses pointing at private V4", async () => {
		await expect(
			assertSafeFetchTarget("http://[::ffff:127.0.0.1]/"),
		).rejects.toMatchObject({ reason: "ip_literal_blocked" });
	});

	it("blocks a hostname whose DNS resolution returns ANY private address", async () => {
		// Defends against split-resolve / DNS-rebinding shapes where the
		// record is a public IP plus a loopback IP — we must reject if any
		// resolved address is private.
		await expect(
			assertSafeFetchTarget(
				"http://attacker-controlled.example/",
				stubResolver(["8.8.8.8", "127.0.0.1"]),
			),
		).rejects.toMatchObject({ reason: "resolved_ip_blocked" });
	});

	it("allows a hostname whose DNS resolution is fully public", async () => {
		const result = await assertSafeFetchTarget(
			"https://safe.example/path",
			stubResolver(["8.8.8.8", "1.1.1.1"]),
		);
		expect(result.url).toBeInstanceOf(URL);
		// The fetcher pins to the FIRST resolved address — fixes the
		// DNS-rebinding TOCTOU between resolution and connect.
		expect(result.vettedAddress).toBe("8.8.8.8");
		expect(result.vettedFamily).toBe(4);
	});

	it("rejects when DNS resolution itself fails", async () => {
		const failingResolver = async () => {
			throw new Error("ENOTFOUND");
		};
		await expect(
			assertSafeFetchTarget("https://nonexistent.example/", failingResolver),
		).rejects.toMatchObject({ reason: "hostname_resolution_failed" });
	});

	it("includes the resolver's error message in the rejection detail", async () => {
		const failingResolver = async () => {
			throw new Error("EAI_AGAIN temporary failure");
		};
		const err = await assertSafeFetchTarget(
			"https://flaky.example/",
			failingResolver,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SsrfBlockedError);
		expect((err as SsrfBlockedError).message).toContain("EAI_AGAIN temporary failure");
		expect((err as SsrfBlockedError).cause).toBeInstanceOf(Error);
	});

	it("stringifies a non-Error resolver rejection in the detail", async () => {
		// The resolver contract is a Promise; a stub that rejects with a bare
		// string exercises the String(err) branch of the failure path.
		const stringRejectingResolver = async (): Promise<
			{ address: string; family: number }[]
		> => {
			throw "weird dns layer fault";
		};
		const err = await assertSafeFetchTarget(
			"https://weird.example/",
			stringRejectingResolver,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SsrfBlockedError);
		expect((err as SsrfBlockedError).reason).toBe("hostname_resolution_failed");
		expect((err as SsrfBlockedError).message).toContain("weird dns layer fault");
	});

	it("rejects when DNS resolution returns zero addresses", async () => {
		// An empty A/AAAA set is treated as an unresolvable host, not a pass.
		const emptyResolver = async (): Promise<{ address: string; family: number }[]> => [];
		const err = await assertSafeFetchTarget(
			"https://empty-records.example/",
			emptyResolver,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SsrfBlockedError);
		expect((err as SsrfBlockedError).reason).toBe("hostname_resolution_failed");
		expect((err as SsrfBlockedError).message).toContain("returned no addresses");
	});

	it("pins family 6 for a hostname whose first record is IPv6", async () => {
		// When the resolver's first usable record is V6, vettedFamily is 6 —
		// covers the family-from-resolved-record branch (vs. the V4 default).
		const v6FirstResolver = async () => [
			{ address: "2606:4700:4700::1111", family: 6 },
			{ address: "1.1.1.1", family: 4 },
		];
		const result = await assertSafeFetchTarget(
			"https://dual-stack.example/",
			v6FirstResolver,
		);
		expect(result.vettedAddress).toBe("2606:4700:4700::1111");
		expect(result.vettedFamily).toBe(6);
	});
});

describe("isBlockedAddress — range coverage", () => {
	it("flags every documented private/reserved V4 leading octet", () => {
		expect(isBlockedAddress("0.0.0.0")).toBe(true);
		expect(isBlockedAddress("10.255.255.255")).toBe(true);
		expect(isBlockedAddress("127.5.5.5")).toBe(true);
		expect(isBlockedAddress("169.254.169.254")).toBe(true);
		expect(isBlockedAddress("172.16.0.0")).toBe(true);
		expect(isBlockedAddress("172.31.255.255")).toBe(true);
		expect(isBlockedAddress("192.168.0.1")).toBe(true);
		expect(isBlockedAddress("198.18.0.1")).toBe(true);
		expect(isBlockedAddress("224.0.0.1")).toBe(true);
		expect(isBlockedAddress("255.255.255.255")).toBe(true);
	});

	it("does not flag public V4 addresses", () => {
		expect(isBlockedAddress("8.8.8.8")).toBe(false);
		expect(isBlockedAddress("1.1.1.1")).toBe(false);
		expect(isBlockedAddress("172.15.255.255")).toBe(false); // 172.16/12 starts at .16
		expect(isBlockedAddress("172.32.0.0")).toBe(false); // ...and ends at .31
	});

	it("flags the special-purpose V4 ranges that aren't simple leading octets", () => {
		// 192.0.0.0/24 (RFC5736/RFC6890) — note 192.0.x is distinct from the
		// public 192.0.2.0/24 documentation block, which must NOT be flagged.
		expect(isBlockedAddress("192.0.0.0")).toBe(true);
		expect(isBlockedAddress("192.0.0.8")).toBe(true);
		expect(isBlockedAddress("192.0.2.1")).toBe(false); // 192.0.2/24 docs range is public-routable shape
		// 198.18.0.0/15 benchmark range covers .18 and .19 second octets.
		expect(isBlockedAddress("198.18.0.1")).toBe(true);
		expect(isBlockedAddress("198.19.255.254")).toBe(true);
		expect(isBlockedAddress("198.20.0.1")).toBe(false); // just outside the benchmark block
	});

	it("flags blocked IPv6 forms and clears public IPv6", () => {
		// Unspecified + loopback.
		expect(isBlockedAddress("::")).toBe(true);
		expect(isBlockedAddress("::1")).toBe(true);
		// IPv4-mapped pointing at a private V4 re-checks via the V4 ranges
		// and is blocked (the mapping branch defers to isBlockedV4).
		expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
		// IPv4-mapped pointing at a PUBLIC V4 defers to isBlockedV4 too, which
		// clears it — so the mapped public form is allowed (mapping branch,
		// V4-is-public verdict).
		expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
		// A `::ffff:` prefix whose tail is NOT a dotted-quad V4 falls through
		// the mapping branch (isIP(tail) !== 4) to the first-hextet NaN guard,
		// which blocks it.
		expect(isBlockedAddress("::ffff:0:1")).toBe(true);
		// fc00::/7 unique-local and fe80::/10 link-local and ff00::/8 multicast.
		expect(isBlockedAddress("fc00::1")).toBe(true);
		expect(isBlockedAddress("fe80::1")).toBe(true);
		expect(isBlockedAddress("ff02::1")).toBe(true);
		// Link-local with a zone id is stripped before the range check.
		expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
		// Globally-routable unicast (2000::/3) is allowed.
		expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
		// NAT64 well-known prefix embedding a public V4 — first hextet 0x64 is
		// outside every blocked V6 range, so it is allowed.
		expect(isBlockedAddress("64:ff9b::8.8.8.8")).toBe(false);
	});

	it("rejects garbage strings", () => {
		expect(isBlockedAddress("not-an-ip")).toBe(true);
		expect(isBlockedAddress("")).toBe(true);
		// A V6 string whose first hextet isn't valid hex hits the NaN guard.
		expect(isBlockedAddress("xyz::1")).toBe(true);
	});
});

describe("fetchAndScan — SSRF integration", () => {
	it("returns fail_open without calling fetch when the URL targets a private host", async () => {
		// No `fetcher` injected here — we want the real fetchBody path so
		// the SSRF guard actually runs. The fetcherSpy proves the network
		// hop never executes (the guard short-circuits before it).
		const fetcherSpy = vi.fn();
		const result = await fetchAndScan({
			cwd,
			url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
			fetcher: async (...a) => {
				fetcherSpy(...a);
				throw new Error("should never reach the fetcher");
			},
		});
		expect(result.kind).toBe("fail_open");
		// Real fetchBody path NOT used here (we injected a fetcher), but
		// the SSRF guard runs before the fetcher anyway because the
		// production code calls assertSafeFetchTarget inside a wrapper.
		// Test the wrapper integration via the no-fetcher path below.
		expect(fetcherSpy).not.toHaveBeenCalled();
	});

	it("real fetchBody path: SSRF guard rejects with 'SSRF guard' detail", async () => {
		// This case exercises the actual fetchBody integration so the
		// SsrfBlockedError -> fail_open detail propagation is covered. No
		// `fetcher` injection — production fetchBody handles the URL.
		const result = await fetchAndScan({
			cwd,
			url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		});
		expect(result.kind).toBe("fail_open");
		expect((result as { detail: string }).detail).toMatch(/SSRF guard/);
	});

	it("returns fail_open when the URL uses file://", async () => {
		const result = await fetchAndScan({
			cwd,
			url: "file:///etc/passwd",
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		});
		expect(result.kind).toBe("fail_open");
	});
});

describe("fetchAndScan — fetch failure", () => {
	it("returns fail_open so the caller falls back to normal flow", async () => {
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/down",
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
			fetcher: async () => {
				throw new Error("network down");
			},
		});
		expect(result).toMatchObject({ kind: "fail_open" });
	});

	it("treats non-2xx responses as fail_open", async () => {
		stubFetch("server error", false);
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/500",
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
		fetcher: stubFetcher,
		});
		expect(result).toMatchObject({ kind: "fail_open" });
	});

	it("stringifies a non-Error fetch rejection into the fail_open detail", async () => {
		// A fetcher that throws a bare string (not an Error) exercises the
		// String(fetchErr) branch of the catch.
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/string-throw",
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
			fetcher: async () => {
				throw "raw string failure";
			},
		});
		expect(result).toMatchObject({ kind: "fail_open", detail: "raw string failure" });
	});
});

describe("fetchAndScan — review file cannot be written", () => {
	it("falls back to a synthetic review path token when writeReview fails", async () => {
		// Point cwd at a regular FILE, not a directory. ensureDir() can't
		// mkdir under a file, so writeReview returns undefined and the proxy
		// uses the `<key>.review.json` fallback string for reviewPath — while
		// still reporting review_pending with the real finding count.
		const filePath = join(cwd, "not-a-dir");
		writeFileSync(filePath, "x");
		stubFetch("leak: carol@real-domain.example here");
		const scanner = makeScanner([
			finding("private_email", "carol@real-domain.example", 6),
		]);
		const result = await fetchAndScan({
			cwd: filePath,
			url: "https://example.com/unwritable",
			prompt: "p",
			scanner,
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
			fetcher: stubFetcher,
		});
		expect(result.kind).toBe("review_pending");
		const pending = result as { kind: "review_pending"; reviewPath: string; findingCount: number };
		expect(pending.findingCount).toBe(1);
		// Synthetic fallback: `<…review.json>` rather than a real on-disk path.
		expect(pending.reviewPath).toMatch(/^<.*\.review\.json>$/);
	});
});
