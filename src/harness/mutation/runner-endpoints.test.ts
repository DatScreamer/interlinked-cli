import { describe, expect, it } from "vitest";
import { configuredMaxTestScope, configuredRunnerEndpoints } from "./runner-endpoints.js";

describe("configuredRunnerEndpoints", () => {
	it("P1: reads runner_url + runner_urls + token from the local rules file", () => {
		const files = new Map([
			[
				"/repo/.interlinked/guard-rules.local.json",
				JSON.stringify({
					per_edit_mutation: { runner_url: "http://a/", runner_urls: ["http://b/"], token: "tok" },
				}),
			],
		]);
		const cfg = configuredRunnerEndpoints("/repo", (p) => files.get(p) ?? null);
		expect(cfg.endpoints).toEqual(["http://a/", "http://b/"]);
		expect(cfg.token).toBe("tok");
	});

	it("P2: keeps a valid runner_url when runner_urls is a string rather than an array — the old unchecked cast spread it into one bogus endpoint per character", () => {
		const files = new Map([
			[
				"/repo/.interlinked/guard-rules.local.json",
				JSON.stringify({ per_edit_mutation: { runner_url: "http://a/", runner_urls: "oops" } }),
			],
		]);
		const cfg = configuredRunnerEndpoints("/repo", (p) => files.get(p) ?? null);
		expect(cfg.endpoints).toEqual(["http://a/"]);
	});

	it("N1: returns no endpoints when the local rules file is absent", () => {
		expect(configuredRunnerEndpoints("/repo", () => null).endpoints).toEqual([]);
	});

	it("N2: returns no endpoints when the local rules file is malformed JSON", () => {
		const cfg = configuredRunnerEndpoints("/repo", () => "{not json");
		expect(cfg.endpoints).toEqual([]);
	});

	it("N3: valid JSON with no `per_edit_mutation` key yields no endpoints and no token", () => {
		const files = new Map([["/repo/.interlinked/guard-rules.local.json", JSON.stringify({ other: true })]]);
		const cfg = configuredRunnerEndpoints("/repo", (p) => files.get(p) ?? null);
		expect(cfg).toEqual({ endpoints: [] });
	});

	it("N4: a non-iterable runner_urls (e.g. a number) does not wipe out an otherwise-valid runner_url — the old cast's spread would throw and lose both", () => {
		const files = new Map([
			[
				"/repo/.interlinked/guard-rules.local.json",
				JSON.stringify({ per_edit_mutation: { runner_url: "http://a/", runner_urls: 5 } }),
			],
		]);
		const cfg = configuredRunnerEndpoints("/repo", (p) => files.get(p) ?? null);
		expect(cfg.endpoints).toEqual(["http://a/"]);
	});

	it("N5: drops non-string entries inside an otherwise-valid runner_urls array", () => {
		const files = new Map([
			[
				"/repo/.interlinked/guard-rules.local.json",
				JSON.stringify({ per_edit_mutation: { runner_urls: [123, "http://b/", null] } }),
			],
		]);
		const cfg = configuredRunnerEndpoints("/repo", (p) => files.get(p) ?? null);
		expect(cfg.endpoints).toEqual(["http://b/"]);
	});

	it("N6: a per_edit_mutation value that is not an object (e.g. a string) yields no endpoints and no token", () => {
		const files = new Map([
			["/repo/.interlinked/guard-rules.local.json", JSON.stringify({ per_edit_mutation: "oops" })],
		]);
		const cfg = configuredRunnerEndpoints("/repo", (p) => files.get(p) ?? null);
		expect(cfg).toEqual({ endpoints: [] });
	});
});

describe("configuredMaxTestScope (plan 25 Class-2 knob)", () => {
	// test-contract: public-api — local file wins, shared file is the fallback,
	// invalid values fall through to the shipped default (undefined)
	it("P: reads a positive max_test_scope, local file winning over shared", () => {
		const files = new Map<string, string>([
			[
				"/repo/.interlinked/guard-rules.local.json",
				JSON.stringify({ per_edit_mutation: { max_test_scope: 300 } }),
			],
			[
				"/repo/.interlinked/guard-rules.json",
				JSON.stringify({ per_edit_mutation: { max_test_scope: 40 } }),
			],
		]);
		expect(configuredMaxTestScope("/repo", (p) => files.get(p) ?? null)).toBe(300);
	});

	// test-contract: behavior — the shared rules file backs the local one
	it("P: falls back to the shared rules file when no local override exists", () => {
		const files = new Map<string, string>([
			[
				"/repo/.interlinked/guard-rules.json",
				JSON.stringify({ per_edit_mutation: { max_test_scope: 40 } }),
			],
		]);
		expect(configuredMaxTestScope("/repo", (p) => files.get(p) ?? null)).toBe(40);
	});

	// test-contract: boundary — only positive finite numbers configure the cap
	it("N: zero, negative, non-numeric, malformed, and absent all yield undefined", () => {
		const bad = (payload: string | null): number | undefined =>
			configuredMaxTestScope("/repo", () => payload);
		expect(bad(null)).toBeUndefined();
		expect(bad("{not json")).toBeUndefined();
		expect(bad(JSON.stringify({ per_edit_mutation: { max_test_scope: 0 } }))).toBeUndefined();
		expect(bad(JSON.stringify({ per_edit_mutation: { max_test_scope: -5 } }))).toBeUndefined();
		expect(bad(JSON.stringify({ per_edit_mutation: { max_test_scope: "many" } }))).toBeUndefined();
	});
});
