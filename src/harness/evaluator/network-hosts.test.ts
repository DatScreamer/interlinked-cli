import { describe, expect, it } from "vitest";
import { hasPublicHttpUrl, isNonRoutableHost } from "./network-hosts.js";

describe("isNonRoutableHost", () => {
	describe("— positive (must be non-routable)", () => {
		it("P1: loopback 127.0.0.1", () => expect(isNonRoutableHost("127.0.0.1")).toBe(true));
		it("P2: 127.x.x.x /8", () => expect(isNonRoutableHost("127.5.5.5")).toBe(true));
		it("P3: bracketed loopback", () => expect(isNonRoutableHost("[127.0.0.1]")).toBe(true));
		it("P4: localhost", () => expect(isNonRoutableHost("localhost")).toBe(true));
		it("P5: local hostname matching is case-insensitive", () =>
			expect(isNonRoutableHost("BUILD-BOX.LOCAL")).toBe(true));
		it("P6: IPv6 loopback", () => expect(isNonRoutableHost("::1")).toBe(true));
		it("P7: bracketed IPv6 loopback", () => expect(isNonRoutableHost("[::1]")).toBe(true));
		it("P8: wildcard bind address", () => expect(isNonRoutableHost("0.0.0.0")).toBe(true));
		it("P9: private 10/8", () => expect(isNonRoutableHost("10.1.2.3")).toBe(true));
		it("P10: private 192.168/16", () => expect(isNonRoutableHost("192.168.1.1")).toBe(true));
		it("P11: private 172.16/12 low", () => expect(isNonRoutableHost("172.16.0.1")).toBe(true));
		it("P12: private 172.31/12 high", () => expect(isNonRoutableHost("172.31.255.1")).toBe(true));
		it("P13: CGNAT lower boundary", () => expect(isNonRoutableHost("100.64.0.0")).toBe(true));
		it("P14: CGNAT upper boundary", () => expect(isNonRoutableHost("100.127.255.255")).toBe(true));
		it("P15: CGNAT/tailnet 100.64/10 (the 2026-08-11 case)", () =>
			expect(isNonRoutableHost("100.97.48.15")).toBe(true));
		it("P16: link-local 169.254/16", () => expect(isNonRoutableHost("169.254.1.1")).toBe(true));
		it("P17: .local mDNS name", () => expect(isNonRoutableHost("mac-mini.local")).toBe(true));
	});
	describe("— negative (must be routable/public)", () => {
		it("N1: public IP", () => expect(isNonRoutableHost("8.8.8.8")).toBe(false));
		it("N2: 192.167 is outside the private /16", () => expect(isNonRoutableHost("192.167.1.1")).toBe(false));
		it("N3: 192.169 is outside the private /16", () => expect(isNonRoutableHost("192.169.1.1")).toBe(false));
		it("N4: 172.15 is NOT in the /12", () => expect(isNonRoutableHost("172.15.0.1")).toBe(false));
		it("N5: 172.32 is NOT in the /12", () => expect(isNonRoutableHost("172.32.0.1")).toBe(false));
		it("N6: 100.63 is below CGNAT", () => expect(isNonRoutableHost("100.63.0.1")).toBe(false));
		it("N7: 100.128 is above CGNAT", () => expect(isNonRoutableHost("100.128.0.1")).toBe(false));
		it("N8: 169.253 is outside link-local", () => expect(isNonRoutableHost("169.253.1.1")).toBe(false));
		it("N9: 169.255 is outside link-local", () => expect(isNonRoutableHost("169.255.1.1")).toBe(false));
		it("N10: public hostname", () => expect(isNonRoutableHost("api.example.com")).toBe(false));
		it("N11: a hostname merely containing .local is public", () =>
			expect(isNonRoutableHost("local.example.com")).toBe(false));
		it("N12: octet overflow is not a valid private IP", () =>
			expect(isNonRoutableHost("999.1.1.1")).toBe(false));
		it("N13: malformed IPv4 is not private", () => expect(isNonRoutableHost("127.0.0")).toBe(false));
		it("N14: non-loopback IPv6 is public", () => expect(isNonRoutableHost("2001:db8::1")).toBe(false));
	});
});

describe("hasPublicHttpUrl", () => {
	describe("— positive (has a public URL)", () => {
		it("P1: public URL", () => expect(hasPublicHttpUrl("curl https://api.example.com/x")).toBe(true));
		it("P2: public alongside loopback (mixed → still public)", () =>
			expect(hasPublicHttpUrl("curl http://127.0.0.1:8790 ; curl https://example.com")).toBe(true));
		it("P3: URL matching is case-insensitive", () =>
			expect(hasPublicHttpUrl("curl HTTPS://api.example.com/x")).toBe(true));
	});
	describe("— negative (only non-routable)", () => {
		it("N1: loopback health poll", () =>
			expect(hasPublicHttpUrl("curl -s http://127.0.0.1:8790/health")).toBe(false));
		it("N2: tailnet peer poll (the 2026-08-11 case)", () =>
			expect(hasPublicHttpUrl("curl -s -m 5 http://100.97.48.15:8790/health")).toBe(false));
		it("N3: two non-routable hosts in one command", () =>
			expect(
				hasPublicHttpUrl("curl http://127.0.0.1:8790/health; curl http://100.97.48.15:8790/health"),
			).toBe(false));
		it("N4: no URL at all", () => expect(hasPublicHttpUrl("du -sh /tmp/*")).toBe(false));
		it("N5: quoted loopback URL", () =>
			expect(hasPublicHttpUrl('curl "http://localhost:8790/health"')).toBe(false));
		it("N6: non-http URL is ignored", () => expect(hasPublicHttpUrl("curl ftp://example.com/file")).toBe(false));
	});
});
