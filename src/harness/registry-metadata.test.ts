// Admission-screen network module. No real network anywhere in here — every
// test injects fetchImpl, and the assertions pin the exact URLs/bodies sent so
// a refactor can't silently start querying the wrong registry.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import type { Ecosystem } from "./package-install-parser.js";
import {
	fetchRegistryMetadata,
	fetchVersionMetadata,
	queryOsvAdvisories,
} from "./registry-metadata.js";

type FetchImpl = typeof globalThis.fetch;

function fakeFetch(body: unknown, opts: { ok?: boolean } = {}): FetchImpl {
	return vi.fn(async () => ({
		ok: opts.ok ?? true,
		json: async () => body,
	})) as unknown as FetchImpl;
}

function throwingFetch(): FetchImpl {
	return vi.fn(async () => {
		throw new Error("network down");
	}) as unknown as FetchImpl;
}

function urlOf(f: FetchImpl): string {
	return nonNull((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0])[0] as string;
}

describe("fetchRegistryMetadata — per ecosystem", () => {
	it("npm: reads version + license from the /latest dist-tag endpoint", async () => {
		const f = fakeFetch({ version: "4.17.21", license: "MIT" });
		const meta = await fetchRegistryMetadata("npm", "lodash", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "4.17.21", license: "MIT" });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/lodash/latest");
	});

	it("npm: escapes the inner slash of a scoped name", async () => {
		const f = fakeFetch({ version: "1.0.0", license: "MIT" });
		await fetchRegistryMetadata("npm", "@types/node", { fetchImpl: f });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/@types%2Fnode/latest");
	});

	it("pypi: prefers PEP 639 license_expression over legacy license prose", async () => {
		const f = fakeFetch({
			info: { version: "2.32.0", license: "long prose here", license_expression: "Apache-2.0" },
		});
		const meta = await fetchRegistryMetadata("pypi", "requests", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "2.32.0", license: "Apache-2.0" });
		expect(urlOf(f)).toBe("https://pypi.org/pypi/requests/json");
	});

	it("pypi: falls back to the legacy license field", async () => {
		const f = fakeFetch({ info: { version: "1.0.0", license: "MIT" } });
		const meta = await fetchRegistryMetadata("pypi", "leftpadpy", { fetchImpl: f });
		expect(meta?.license).toBe("MIT");
	});

	it("cargo: normalizes crates.io slash dual-licensing to SPDX OR", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.219", max_version: "2.0.0-rc.1" },
			versions: [{ license: "MIT/Apache-2.0" }],
		});
		const meta = await fetchRegistryMetadata("cargo", "serde", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.219", license: "MIT OR Apache-2.0" });
		expect(urlOf(f)).toBe("https://crates.io/api/v1/crates/serde");
	});

	// Round 7 (finding 2026-06): versions[0] is newest-OVERALL, which can be a
	// prerelease when max_version > max_stable_version. The license must come
	// from the entry whose `num` equals the CHOSEN (stable) version, not the
	// prerelease — otherwise advisories are screened for one version and the
	// license enforced for another.
	it("cargo: takes the license of the STABLE version, not a newer prerelease", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.0", max_version: "2.0.0-rc.1" },
			versions: [
				{ num: "2.0.0-rc.1", license: "GPL-3.0-only" }, // newest overall (prerelease)
				{ num: "1.0.0", license: "MIT" }, // the chosen stable release
			],
		});
		const meta = await fetchRegistryMetadata("cargo", "somecrate", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.0", license: "MIT" });
	});

	it("cargo: falls back to newest-overall license when no entry matches the chosen version", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.0", max_version: "1.0.0" },
			versions: [{ license: "BSD-3-Clause" }], // no `num` — cannot be matched
		});
		const meta = await fetchRegistryMetadata("cargo", "oldcrate", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.0", license: "BSD-3-Clause" });
	});

	it("rubygems: joins the licenses array as an OR choice", async () => {
		const f = fakeFetch({ version: "7.1.0", licenses: ["MIT", "Ruby"] });
		const meta = await fetchRegistryMetadata("rubygems", "rails", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "7.1.0", license: "MIT OR Ruby" });
		expect(urlOf(f)).toBe("https://rubygems.org/api/v1/gems/rails.json");
	});

	it("go: returns null without touching the network (no metadata API)", async () => {
		const f = fakeFetch({});
		const meta = await fetchRegistryMetadata("go", "github.com/pkg/errors", { fetchImpl: f });
		expect(meta).toBeNull();
		expect(f).not.toHaveBeenCalled();
	});

	it("unsupported ecosystem: returns null via the switch default", async () => {
		const f = fakeFetch({ version: "1.0.0" });
		const meta = await fetchRegistryMetadata("conda" as Ecosystem, "numpy", { fetchImpl: f });
		expect(meta).toBeNull();
		expect(f).not.toHaveBeenCalled();
	});

	it("cargo: empty crate object → null (no version recorded)", async () => {
		const f = fakeFetch({ crate: {}, versions: [{ license: "MIT" }] });
		const meta = await fetchRegistryMetadata("cargo", "ghost", { fetchImpl: f });
		expect(meta).toBeNull();
	});

	it("cargo: a non-array `versions` field is treated as empty", async () => {
		// crate present (so we don't early-return) but versions is malformed →
		// the Array.isArray guard yields [], newest = rec(undefined) = {}, license undefined.
		const f = fakeFetch({
			crate: { max_stable_version: "3.2.1" },
			versions: "not-an-array",
		});
		const meta = await fetchRegistryMetadata("cargo", "weirdcrate", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "3.2.1", license: undefined });
	});

	it("cargo: falls back to max_version when max_stable_version is absent", async () => {
		const f = fakeFetch({
			crate: { max_version: "0.5.0" },
			versions: [{ num: "0.5.0", license: "Apache-2.0" }],
		});
		const meta = await fetchRegistryMetadata("cargo", "prerelease-only", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "0.5.0", license: "Apache-2.0" });
	});

	it("rubygems: empty json object → null", async () => {
		const f = fakeFetch({});
		const meta = await fetchRegistryMetadata("rubygems", "ghost-gem", { fetchImpl: f });
		expect(meta).toBeNull();
	});

	it("rubygems: a non-array `licenses` field yields an undefined license", async () => {
		const f = fakeFetch({ version: "2.0.0", licenses: null });
		const meta = await fetchRegistryMetadata("rubygems", "no-license-gem", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "2.0.0", license: undefined });
	});

	it("rubygems: an empty (or fully blank) licenses array yields undefined, not an empty string", async () => {
		const f = fakeFetch({ version: "2.0.0", licenses: ["", "   "] });
		const meta = await fetchRegistryMetadata("rubygems", "blank-license-gem", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "2.0.0", license: undefined });
	});
});

describe("fetchRegistryMetadata — default fetch implementation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses globalThis.fetch when no fetchImpl is injected", async () => {
		const stub = fakeFetch({ version: "9.9.9", license: "MIT" });
		vi.stubGlobal("fetch", stub);
		// No fetchImpl in opts → the `opts.fetchImpl ?? globalThis.fetch` fallback fires.
		const meta = await fetchRegistryMetadata("npm", "lodash");
		expect(meta).toEqual({ latestVersion: "9.9.9", license: "MIT" });
		expect(stub).toHaveBeenCalledOnce();
		expect(urlOf(stub)).toBe("https://registry.npmjs.org/lodash/latest");
	});
});

describe("fetchRegistryMetadata — failure shapes (all fail open to null)", () => {
	it("HTTP error status", async () => {
		const meta = await fetchRegistryMetadata("npm", "ghost-pkg", {
			fetchImpl: fakeFetch({}, { ok: false }),
		});
		expect(meta).toBeNull();
	});

	it("network throw", async () => {
		const meta = await fetchRegistryMetadata("npm", "lodash", { fetchImpl: throwingFetch() });
		expect(meta).toBeNull();
	});

	it("response missing the expected shape", async () => {
		const meta = await fetchRegistryMetadata("pypi", "x", { fetchImpl: fakeFetch("not json obj") });
		expect(meta).toBeNull();
	});

	it("absent fields come back undefined, not invented", async () => {
		const meta = await fetchRegistryMetadata("npm", "no-license-pkg", {
			fetchImpl: fakeFetch({ version: "1.0.0" }),
		});
		expect(meta).toEqual({ latestVersion: "1.0.0", license: undefined });
	});

	it("timeout: the abort timer fires and the rejected fetch fails open to null", async () => {
		// fetchImpl honours the injected AbortSignal — it never resolves on its own,
		// so the only way it settles is the setTimeout(abort) firing. timeoutMs:1
		// guarantees the timer wins, exercising the abort callback + catch arm.
		const abortAwareFetch = vi.fn((_url: string, init?: RequestInit) => {
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) {
					reject(new DOMException("aborted", "AbortError"));
					return;
				}
				signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		}) as unknown as FetchImpl;
		const meta = await fetchRegistryMetadata("npm", "slow-pkg", {
			fetchImpl: abortAwareFetch,
			timeoutMs: 1,
		});
		expect(meta).toBeNull();
		expect(abortAwareFetch).toHaveBeenCalledOnce();
	});
});

describe("queryOsvAdvisories", () => {
	it("posts the OSV ecosystem spelling and version, parses vuln ids", async () => {
		const f = fakeFetch({
			vulns: [
				{ id: "RUSTSEC-2023-0071", summary: "timing side-channel" },
				{ id: "GHSA-xxxx", summary: "" },
				{ notAnId: true },
			],
		});
		const advisories = await queryOsvAdvisories("cargo", "rsa", "0.9.0", { fetchImpl: f });
		expect(advisories).toEqual([
			{ id: "RUSTSEC-2023-0071", summary: "timing side-channel" },
			{ id: "GHSA-xxxx", summary: undefined },
		]);
		const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(nonNull(call)[0]).toBe("https://api.osv.dev/v1/query");
		const body = JSON.parse((nonNull(call)[1] as { body: string }).body);
		expect(body).toEqual({
			version: "0.9.0",
			package: { name: "rsa", ecosystem: "crates.io" },
		});
	});

	it("maps the remaining ecosystems to OSV spellings", async () => {
		for (const [eco, spelled] of [
			["npm", "npm"],
			["pypi", "PyPI"],
			["rubygems", "RubyGems"],
			["go", "Go"],
		] as const) {
			const f = fakeFetch({ vulns: [] });
			await queryOsvAdvisories(eco, "pkg", "1.0.0", { fetchImpl: f });
			const body = JSON.parse(
				(nonNull((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0])[1] as { body: string }).body,
			);
			expect(body.package.ecosystem).toBe(spelled);
		}
	});

	it("treats OSV's empty-object response as a clean empty result, not a failure", async () => {
		const advisories = await queryOsvAdvisories("npm", "lodash", "4.17.21", {
			fetchImpl: fakeFetch({}),
		});
		expect(advisories).toEqual([]);
	});

	it("returns null (screen skipped) on network failure", async () => {
		expect(
			await queryOsvAdvisories("npm", "lodash", "4.17.21", { fetchImpl: throwingFetch() }),
		).toBeNull();
	});

	it("returns null on HTTP error status", async () => {
		expect(
			await queryOsvAdvisories("npm", "lodash", "4.17.21", {
				fetchImpl: fakeFetch({}, { ok: false }),
			}),
		).toBeNull();
	});
});

describe("fetchVersionMetadata — pins the version-specific endpoint per ecosystem", () => {
	it("npm: queries the exact version dist-tag, returns its license", async () => {
		const f = fakeFetch({ version: "4.17.20", license: "MIT" });
		const meta = await fetchVersionMetadata("npm", "lodash", "4.17.20", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "4.17.20", license: "MIT" });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/lodash/4.17.20");
	});

	it("npm: escapes a scoped name's inner slash and url-encodes the version", async () => {
		const f = fakeFetch({ version: "18.0.0", license: "MIT" });
		await fetchVersionMetadata("npm", "@types/node", "18.0.0", { fetchImpl: f });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/@types%2Fnode/18.0.0");
	});

	it("npm: an empty body fails open to null", async () => {
		const meta = await fetchVersionMetadata("npm", "ghost", "1.0.0", { fetchImpl: fakeFetch({}) });
		expect(meta).toBeNull();
	});

	it("pypi: hits the /{name}/{version}/json endpoint and prefers license_expression", async () => {
		const f = fakeFetch({
			info: { version: "2.31.0", license: "legacy prose", license_expression: "Apache-2.0" },
		});
		const meta = await fetchVersionMetadata("pypi", "requests", "2.31.0", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "2.31.0", license: "Apache-2.0" });
		expect(urlOf(f)).toBe("https://pypi.org/pypi/requests/2.31.0/json");
	});

	it("pypi: falls back to the legacy license field when no expression", async () => {
		const f = fakeFetch({ info: { version: "1.2.3", license: "BSD-3-Clause" } });
		const meta = await fetchVersionMetadata("pypi", "somepkg", "1.2.3", { fetchImpl: f });
		expect(meta?.license).toBe("BSD-3-Clause");
	});

	it("pypi: an absent info block fails open to null", async () => {
		const meta = await fetchVersionMetadata("pypi", "x", "1.0.0", { fetchImpl: fakeFetch({}) });
		expect(meta).toBeNull();
	});

	it("cargo: selects the matching version's license and normalizes slash dual-licensing", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.219" },
			versions: [
				{ num: "1.0.219", license: "MIT/Apache-2.0" },
				{ num: "1.0.218", license: "GPL-3.0-only" },
			],
		});
		const meta = await fetchVersionMetadata("cargo", "serde", "1.0.219", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.219", license: "MIT OR Apache-2.0" });
		// Always queries the whole-crate endpoint — the per-version license is already in it.
		expect(urlOf(f)).toBe("https://crates.io/api/v1/crates/serde");
	});

	it("cargo: returns null when the requested version is not among the crate's versions", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.0" },
			versions: [{ num: "1.0.0", license: "MIT" }],
		});
		const meta = await fetchVersionMetadata("cargo", "serde", "0.0.1", { fetchImpl: f });
		expect(meta).toBeNull();
	});

	it("cargo: a non-array versions field means no match → null", async () => {
		const f = fakeFetch({ crate: {}, versions: undefined });
		const meta = await fetchVersionMetadata("cargo", "broken", "1.0.0", { fetchImpl: f });
		expect(meta).toBeNull();
	});

	it("rubygems: hits the v2 versioned endpoint and ORs the licenses array", async () => {
		const f = fakeFetch({ licenses: ["MIT", "Ruby"] });
		const meta = await fetchVersionMetadata("rubygems", "rails", "7.0.0", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "7.0.0", license: "MIT OR Ruby" });
		expect(urlOf(f)).toBe("https://rubygems.org/api/v2/rubygems/rails/versions/7.0.0.json");
	});

	it("rubygems: an empty json object fails open to null", async () => {
		const meta = await fetchVersionMetadata("rubygems", "ghost", "1.0.0", {
			fetchImpl: fakeFetch({}),
		});
		expect(meta).toBeNull();
	});

	it("rubygems: a present body with an empty licenses array yields an undefined license", async () => {
		// Body is non-empty (version key) so it is not the null path; licenses is
		// an array but empty → license must come back undefined, not "".
		const f = fakeFetch({ version: "ignored", licenses: [] });
		const meta = await fetchVersionMetadata("rubygems", "no-license-gem", "3.1.0", {
			fetchImpl: f,
		});
		expect(meta).toEqual({ latestVersion: "3.1.0", license: undefined });
	});

	it("rubygems: a non-array licenses field takes the [] fallback branch", async () => {
		// Distinct from the empty-array case above: exercises the Array.isArray=false
		// arm of the ternary so a malformed `licenses` can't throw or leak a value.
		const f = fakeFetch({ version: "ignored", licenses: "MIT" });
		const meta = await fetchVersionMetadata("rubygems", "weird-license-gem", "3.2.0", {
			fetchImpl: f,
		});
		expect(meta).toEqual({ latestVersion: "3.2.0", license: undefined });
	});

	it("unsupported ecosystem (go / unknown): returns null without a request", async () => {
		const goFetch = fakeFetch({ version: "1.0.0" });
		expect(
			await fetchVersionMetadata("go", "github.com/pkg/errors", "1.0.0", { fetchImpl: goFetch }),
		).toBeNull();
		expect(goFetch).not.toHaveBeenCalled();

		const unknownFetch = fakeFetch({ version: "1.0.0" });
		expect(
			await fetchVersionMetadata("conda" as Ecosystem, "numpy", "1.0.0", {
				fetchImpl: unknownFetch,
			}),
		).toBeNull();
		expect(unknownFetch).not.toHaveBeenCalled();
	});
});
