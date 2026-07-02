import { describe, expect, it } from "vitest";
import { type CloudRunnerConfig, createCloudMutationRunner, type FetchLike, type FetchResponse } from "./cloud-runner.js";

const SOURCE = "function f(x){ return x > 0; }";
const REPORT = {
	files: {
		"src/f.ts": {
			source: SOURCE,
			mutants: [
				{
					mutatorName: "EqualityOperator",
					replacement: ">=",
					status: "Survived",
					location: { start: { line: 1, column: 25 }, end: { line: 1, column: 26 } },
				},
			],
		},
	},
};

function resp(body: unknown, ok = true, status = 200): FetchResponse {
	return { ok, status, json: () => Promise.resolve(body) };
}

function okFetch(body: unknown): FetchLike {
	return () => Promise.resolve(resp(body));
}

const CFG: CloudRunnerConfig = { url: "https://worker", timeoutMs: 1000 };

describe("createCloudMutationRunner", () => {
	it("is available only when a URL is configured", () => {
		expect(createCloudMutationRunner({ url: "", timeoutMs: 1 }, okFetch(REPORT)).available()).toBe(false);
		expect(createCloudMutationRunner(CFG, okFetch(REPORT)).available()).toBe(true);
	});

	it("posts and adapts a Stryker report into mutants", async () => {
		const { mutants, testRun } = await createCloudMutationRunner(CFG, okFetch(REPORT)).run("src/f.ts", SOURCE);
		expect(mutants).toHaveLength(1);
		expect(mutants[0]?.status).toBe("survived");
		expect(mutants[0]?.raw.replacement).toBe(">=");
		expect(testRun).toBeUndefined(); // a mutants-only report carries no test-run
	});

	it("forward-parses an optional testRun signal from the response (spec §7)", async () => {
		const withRun = { ...REPORT, testRun: { overlayGreen: false, redWitnessSatisfied: true } };
		const { testRun } = await createCloudMutationRunner(CFG, okFetch(withRun)).run("src/f.ts", SOURCE);
		expect(testRun).toEqual({ overlayGreen: false, redWitnessSatisfied: true });
	});

	it("treats a malformed/absent redWitnessSatisfied as null", async () => {
		const withRun = { ...REPORT, testRun: { overlayGreen: true } };
		const { testRun } = await createCloudMutationRunner(CFG, okFetch(withRun)).run("src/f.ts", SOURCE);
		expect(testRun).toEqual({ overlayGreen: true, redWitnessSatisfied: null });
	});

	it("throws on a non-ok response (→ gate turns it into not-measured)", async () => {
		const runner = createCloudMutationRunner(CFG, () => Promise.resolve(resp({}, false, 500)));
		await expect(runner.run("a.ts", "x")).rejects.toThrow();
	});

	it("throws on an unrecognized report", async () => {
		await expect(createCloudMutationRunner(CFG, okFetch(42)).run("a.ts", "x")).rejects.toThrow();
	});

	it("sends the file + overlay content and a bearer token", async () => {
		const captured: { url?: string; body?: string; headers?: Record<string, string> } = {};
		const spy: FetchLike = (url, init) => {
			captured.url = url;
			captured.body = init.body;
			captured.headers = init.headers;
			return Promise.resolve(resp(REPORT));
		};
		await createCloudMutationRunner({ ...CFG, token: "T" }, spy).run("src/f.ts", "OVERLAY");
		expect(captured.url).toBe("https://worker");
		expect(captured.headers?.authorization).toBe("Bearer T");
		expect(captured.body).toContain("OVERLAY");
	});

	it("carries the full overlay set on the wire when provided (spec §7)", async () => {
		let body: string | undefined;
		const spy: FetchLike = (_url, init) => {
			body = init.body;
			return Promise.resolve(resp(REPORT));
		};
		const overlays = [
			{ path: "src/f.ts", content: "SRC" },
			{ path: "src/f.test.ts", content: "TEST" },
		];
		await createCloudMutationRunner(CFG, spy).run("src/f.ts", "SRC", overlays);
		const parsed = JSON.parse(body ?? "{}");
		expect(parsed.overlays).toEqual(overlays);
	});

	it("omits the overlays key entirely when not provided (older-Worker back-compat)", async () => {
		let body: string | undefined;
		const spy: FetchLike = (_url, init) => {
			body = init.body;
			return Promise.resolve(resp(REPORT));
		};
		await createCloudMutationRunner(CFG, spy).run("src/f.ts", "SRC");
		expect(JSON.parse(body ?? "{}")).not.toHaveProperty("overlays");
	});
});
