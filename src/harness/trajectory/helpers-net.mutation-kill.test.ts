import { describe, expect, it } from "vitest";
import { extractHosts, isExternalHost, isPrivateOrLoopbackIPv4 } from "./helpers.js";

// Mutation-kill companion targeting extractHosts / isExternalHost / the
// private-IPv4 range checks and the internal (unexported) isIPv4 helper,
// exercised indirectly through isExternalHost. Mutant-id -> fixture mapping
// lives in scratch/fleet-r3/receipts/src_harness_trajectory_helpers.ts.jsonl.

describe("extractHosts — URL loop (https? optional-s, capture group, m[1] guard)", () => {
	it("a plain http:// URL is matched by BOTH the URL loop and the bare-domain loop (2 hits for one host)", () => {
		const hosts = extractHosts("curl http://example.com/x");
		expect(hosts.filter((h) => h === "example.com")).toHaveLength(2);
	});

	it("the URL-host capture is the FULL run up to the delimiter, not a single char, and not the excluded chars themselves", () => {
		expect(extractHosts("curl http://example.com/x")).toEqual(["example.com", "example.com"]);
	});
});

describe("extractHosts — email loop ({1,64} local part, domain capture, m[1] guard)", () => {
	it("the email-domain capture is the FULL run, and the local-part length bound does not become mandatory-1-char", () => {
		expect(extractHosts("git config user.email bob@example.com")).toContain("example.com");
	});

	// The case above uses a dotted local part ("user.email") and a domain
	// ("example.com") that the UNRELATED bare-domain loop (line ~247 of
	// helpers.ts) ALSO independently matches — so `toContain("example.com")`
	// stays true even when the email loop's own regex/push is mutated away
	// entirely (masked-assertion gap; see scratch/fleet-r3/repair-followups.txt
	// and the W6 receipts for mutantIds a2792e71ed07c8df, 58de28b237c52c4b,
	// ed47c375cc3ba2b7, 75415c9e33ee7320, 511c9393c51ba8fe, d96fbb613270f022,
	// b109958433679a42). "ssh user@localhost" has no "." anywhere, so
	// "localhost" can ONLY be produced by the email loop — no URL/IPv4/
	// bare-domain loop can independently contribute it — making this the
	// discriminating fixture the assertion above never was.
	it("a single-label domain with no dot (localhost) can ONLY come from the email loop, so this isolates it from the other three loops", () => {
		expect(extractHosts("ssh user@localhost")).toEqual(["localhost"]);
	});
});

describe("extractHosts — IPv4 loop (per-octet {1,3}, m[0] guard)", () => {
	it("every IPv4 octet keeps its {1,3} width, not just the first", () => {
		expect(extractHosts("nc 10.20.30.40 8080")).toContain("10.20.30.40");
	});
});

describe("extractHosts — bare-domain loop (m[0] guard)", () => {
	it("a bare dotted hostname with no scheme/user is still pulled (second m[0] guard)", () => {
		expect(extractHosts("ping foo.bar.co.uk")).toContain("foo.bar.co.uk");
	});
});

describe("isPrivateOrLoopbackIPv4 — the whole-string anchors (^ and $) on IPV4_RE itself", () => {
	it("junk glued before an otherwise-valid address must not be accepted as that address (^ anchor)", () => {
		expect(isPrivateOrLoopbackIPv4("xx10.0.0.1")).toBe(false);
	});

	it("junk glued after an otherwise-valid address must not be accepted as that address ($ anchor)", () => {
		expect(isPrivateOrLoopbackIPv4("10.0.0.1x")).toBe(false);
	});
});

describe("isPrivateOrLoopbackIPv4 — the octet-range guard (some/every/[])", () => {
	it("an out-of-range octet in a would-be-private address must still reject it (some, not every/empty-array)", () => {
		expect(isPrivateOrLoopbackIPv4("10.999.2.3")).toBe(false);
	});

	it("255 itself is IN range (boundary of the > 255 check, not >=)", () => {
		expect(isPrivateOrLoopbackIPv4("10.255.255.255")).toBe(true);
	});
});

describe("isPrivateOrLoopbackIPv4 — 169.254/16 special-case guard", () => {
	it("a===169 must be checked for real, not always true", () => {
		expect(isPrivateOrLoopbackIPv4("8.254.0.0")).toBe(false);
	});
});

describe("isPrivateOrLoopbackIPv4 — 172.16-31/12 range guard", () => {
	it("a===172 must be checked for real, not always true", () => {
		expect(isPrivateOrLoopbackIPv4("8.20.0.0")).toBe(false);
	});

	it("b>=16 lower boundary: 172.16.x IS private (>= not >)", () => {
		expect(isPrivateOrLoopbackIPv4("172.16.0.1")).toBe(true);
	});

	it("b<=31 upper boundary must reject values above it, not always pass", () => {
		expect(isPrivateOrLoopbackIPv4("172.99.0.0")).toBe(false);
	});

	it("b<=31 upper boundary: 172.31.x IS private (<= not <)", () => {
		expect(isPrivateOrLoopbackIPv4("172.31.0.1")).toBe(true);
	});
});

describe("isPrivateOrLoopbackIPv4 — 192.168/16 guard (AND of both octets, not OR, neither literal true)", () => {
	it("192.x with the second octet not 168 is not private (rules out both OR and a===192->true)", () => {
		expect(isPrivateOrLoopbackIPv4("192.99.0.0")).toBe(false);
	});

	it("x.168 with the first octet not 192 is not private (rules out a===192->true and the OR)", () => {
		expect(isPrivateOrLoopbackIPv4("8.168.0.0")).toBe(false);
	});
});

describe("isExternalHost — trailing-dot strip (regex $ anchor and its replacement string)", () => {
	it("a fully-qualified domain with a trailing dot still resolves to the real external domain", () => {
		expect(isExternalHost("example.com.")).toBe(true);
	});

	it("a domain with no trailing dot is untouched by the strip", () => {
		expect(isExternalHost("example.com")).toBe(true);
	});
});

describe("isExternalHost — the internal (unexported) isIPv4 gate", () => {
	it("a public dotted-quad IP takes the IP branch and is external (not misrouted to the domain-suffix branch)", () => {
		expect(isExternalHost("8.8.8.8")).toBe(true);
	});

	it("an out-of-range octet must NOT be accepted as an IP (every-vs-some, [^m.slice] mutants)", () => {
		expect(isExternalHost("8.8.8.999")).toBe(false);
	});

	it("255 is a valid octet for the IP gate too (<= not <)", () => {
		expect(isExternalHost("8.8.8.255")).toBe(true);
	});
});

describe("isExternalHost — INTERNAL_TLD / FILE_EXT_TAIL / final-domain end anchors", () => {
	it("'.local' etc. only excludes when it is the actual trailing label, not a mid-string substring", () => {
		expect(isExternalHost("foo.local.example.com")).toBe(true);
	});

	it("a file-extension-shaped tail only excludes at the real end, and is checked for real (not skipped)", () => {
		expect(isExternalHost("backup.tar.gz.example.com")).toBe(true);
		expect(isExternalHost("backup.tar.gz")).toBe(false);
	});

	it("the final letters-only-TLD check is anchored to the end, not a mid-string search", () => {
		expect(isExternalHost("sub.example.123")).toBe(false);
	});
});

describe("isExternalHost — dot-less hosts (equivalent-shaped guard; see receipts for fuzz verdict)", () => {
	it("a bare word with no dot at all is never external", () => {
		expect(isExternalHost("localhost")).toBe(false);
		expect(isExternalHost("foo")).toBe(false);
	});
});
