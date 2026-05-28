import { describe, expect, it } from "vitest";
import {
	b64urlDecode,
	b64urlEncode,
	decodeOAuthState,
	deriveWorkspaceId,
	encodeOAuthState,
	githubAuthorizeUrl,
	parseGithubUser,
	parseProps,
} from "./oauth-helpers.js";

describe("deriveWorkspaceId", () => {
	it("derives a deterministic personal workspace id from the github user id", () => {
		expect(deriveWorkspaceId(12345)).toBe("ws_12345");
	});
	it("is stable across calls (so re-login reuses the same workspace)", () => {
		expect(deriveWorkspaceId(7)).toBe(deriveWorkspaceId(7));
	});
});

describe("b64url round-trip", () => {
	it("round-trips ascii", () => {
		expect(b64urlDecode(b64urlEncode("hello world"))).toBe("hello world");
	});
	it("round-trips unicode + json", () => {
		const s = JSON.stringify({ a: "café ☕", n: 1 });
		expect(b64urlDecode(b64urlEncode(s))).toBe(s);
	});
	it("produces url-safe output (no + / =)", () => {
		const out = b64urlEncode("???>>>???>>>");
		expect(out).not.toMatch(/[+/=]/);
	});
});

describe("encode/decodeOAuthState", () => {
	it("round-trips an opaque OAuth request object", () => {
		const req = { clientId: "abc", redirectUri: "http://localhost:9999/callback", scope: ["x"] };
		expect(decodeOAuthState(encodeOAuthState(req))).toEqual(req);
	});
	it("decode returns null on garbage", () => {
		expect(decodeOAuthState("!!!not-base64!!!")).toBeNull();
	});
	it("decode returns null on empty", () => {
		expect(decodeOAuthState("")).toBeNull();
	});
});

describe("parseGithubUser", () => {
	it("extracts id, login, name from a valid /user response", () => {
		const u = parseGithubUser({ id: 42, login: "octocat", name: "The Octocat", extra: "ignored" });
		expect(u).toEqual({ id: 42, login: "octocat", name: "The Octocat" });
	});
	it("tolerates a missing name (optional)", () => {
		const u = parseGithubUser({ id: 42, login: "octocat" });
		expect(u).toEqual({ id: 42, login: "octocat", name: undefined });
	});
	it("returns null when id is missing or non-numeric", () => {
		expect(parseGithubUser({ login: "octocat" })).toBeNull();
		expect(parseGithubUser({ id: "42", login: "octocat" })).toBeNull();
	});
	it("returns null when login is missing", () => {
		expect(parseGithubUser({ id: 42 })).toBeNull();
	});
	it("returns null on non-object", () => {
		expect(parseGithubUser("nope")).toBeNull();
		expect(parseGithubUser(null)).toBeNull();
	});
});

describe("parseProps", () => {
	const valid = { githubId: 42, login: "octocat", name: "The Octocat", workspaceId: "ws_42" };

	it("returns the props for a valid grant", () => {
		expect(parseProps(valid)).toEqual(valid);
	});
	it("tolerates a missing name", () => {
		expect(parseProps({ githubId: 42, login: "octocat", workspaceId: "ws_42" })).toEqual({
			githubId: 42,
			login: "octocat",
			name: undefined,
			workspaceId: "ws_42",
		});
	});
	it("returns null when githubId is missing or non-numeric", () => {
		expect(parseProps({ login: "octocat", workspaceId: "ws_42" })).toBeNull();
		expect(parseProps({ ...valid, githubId: "42" })).toBeNull();
	});
	it("returns null when login is missing", () => {
		expect(parseProps({ githubId: 42, workspaceId: "ws_42" })).toBeNull();
	});
	it("returns null when workspaceId is missing or empty", () => {
		expect(parseProps({ githubId: 42, login: "octocat" })).toBeNull();
		expect(parseProps({ ...valid, workspaceId: "" })).toBeNull();
	});
	it("returns null on non-object", () => {
		expect(parseProps(null)).toBeNull();
		expect(parseProps("nope")).toBeNull();
	});
});

describe("githubAuthorizeUrl", () => {
	it("builds the GitHub authorize URL with client_id, redirect_uri, scope, state", () => {
		const url = new URL(
			githubAuthorizeUrl({
				clientId: "Ov23xxx",
				redirectUri: "https://example.workers.dev/callback",
				state: "STATE123",
			}),
		);
		expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(url.searchParams.get("client_id")).toBe("Ov23xxx");
		expect(url.searchParams.get("redirect_uri")).toBe("https://example.workers.dev/callback");
		expect(url.searchParams.get("state")).toBe("STATE123");
		expect(url.searchParams.get("scope")).toBe("read:user");
	});
});
