import { describe, expect, it } from "vitest";
import { authenticateRequest } from "./auth.js";
import type { Env } from "./types.js";

// Default parameters resolve `makeEnv(undefined)` to the default value, which
// we don't want in the fails-closed test — keep token explicit.
function makeEnv(token: string | undefined): Env {
	// Whole-object cast — auth doesn't touch SUPERVISOR/FACET, so we
	// avoid constructing a fake DurableObjectNamespace stub.
	return { BEARER_TOKEN: token } as Env;
}

const VALID_TOKEN = "test-token";

describe("authenticateRequest", () => {
	it("fails closed when BEARER_TOKEN is unset", () => {
		const env = makeEnv(undefined);
		const req = new Request("https://example.com", {
			headers: { authorization: "Bearer anything" },
		});
		const result = authenticateRequest(req, env);
		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("BEARER_TOKEN");
	});

	it("rejects request without Authorization header", () => {
		const env = makeEnv(VALID_TOKEN);
		const req = new Request("https://example.com");
		const result = authenticateRequest(req, env);
		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("missing");
	});

	it("rejects request with non-Bearer scheme", () => {
		const env = makeEnv(VALID_TOKEN);
		const req = new Request("https://example.com", {
			headers: { authorization: "Basic abc" },
		});
		const result = authenticateRequest(req, env);
		expect(result.authenticated).toBe(false);
	});

	it("rejects request with wrong token", () => {
		const env = makeEnv(VALID_TOKEN);
		const req = new Request("https://example.com", {
			headers: { authorization: "Bearer wrong-token" },
		});
		const result = authenticateRequest(req, env);
		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("invalid");
	});

	it("authenticates request with correct token", () => {
		const env = makeEnv(VALID_TOKEN);
		const req = new Request("https://example.com", {
			headers: { authorization: `Bearer ${VALID_TOKEN}` },
		});
		const result = authenticateRequest(req, env);
		expect(result.authenticated).toBe(true);
		expect(result.workspace_id).toBe("default");
	});
});
