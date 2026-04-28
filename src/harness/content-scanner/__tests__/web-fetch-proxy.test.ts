// Tests for the WebFetch proxy — the harness's response-side PII gate.
// The proxy intercepts WebFetch at PreToolUse, performs the fetch itself,
// scans the body, and either passes the body through to the agent
// (block-and-answer), stashes a review file for the human, or honours a
// decision the human already made via `interlinked scanner review`.

import { mkdtempSync, rmSync } from "node:fs";
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

function stubFetch(body: string, ok = true): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok,
			status: ok ? 200 : 500,
			text: async () => body,
		})),
	);
}

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
		});
		expect(result).toMatchObject({ kind: "passthrough", body: "hello world, no PII here" });
		// No review file written when nothing was flagged.
		expect(listPendingReviews(cwd)).toEqual([]);
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
		});
		expect(result).toMatchObject({ kind: "decision_resolved", decision: "block" });
		expect((result as { body: string }).body).toMatch(/withheld/i);
		expect((result as { body: string }).body).not.toContain("secret body");
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
		// the URL hostname is a literal IP.
		await expect(assertSafeFetchTarget("http://8.8.8.8/")).resolves.toBeInstanceOf(URL);
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
		await expect(
			assertSafeFetchTarget(
				"https://safe.example/path",
				stubResolver(["8.8.8.8", "1.1.1.1"]),
			),
		).resolves.toBeInstanceOf(URL);
	});

	it("rejects when DNS resolution itself fails", async () => {
		const failingResolver = async () => {
			throw new Error("ENOTFOUND");
		};
		await expect(
			assertSafeFetchTarget("https://nonexistent.example/", failingResolver),
		).rejects.toMatchObject({ reason: "hostname_resolution_failed" });
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

	it("rejects garbage strings", () => {
		expect(isBlockedAddress("not-an-ip")).toBe(true);
		expect(isBlockedAddress("")).toBe(true);
	});
});

describe("fetchAndScan — SSRF integration", () => {
	it("returns fail_open without calling fetch when the URL targets a private host", async () => {
		// Stub fetch so we can assert it was NOT called — the SSRF guard
		// must short-circuit before any network I/O.
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
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
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns fail_open without calling fetch when the URL uses file://", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
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
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("fetchAndScan — fetch failure", () => {
	it("returns fail_open so the caller falls back to normal flow", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		const result = await fetchAndScan({
			cwd,
			url: "https://example.com/down",
			prompt: "",
			scanner: makeScanner([]),
			compiledAllowlist: allowlistEmpty,
			config: baseConfig,
			toolName: "WebFetch",
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
		});
		expect(result).toMatchObject({ kind: "fail_open" });
	});
});
