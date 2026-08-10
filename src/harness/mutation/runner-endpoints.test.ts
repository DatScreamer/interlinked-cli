import { describe, expect, it } from "vitest";
import { configuredRunnerEndpoints } from "./runner-endpoints.js";

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
