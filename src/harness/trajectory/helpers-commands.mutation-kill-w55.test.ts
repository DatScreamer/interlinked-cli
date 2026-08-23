import { describe, expect, it } from "vitest";
import { parseRemoteScriptDownloads } from "./helpers-commands.js";

describe("parseRemoteScriptDownloads — positive (must fire)", () => {
	// test-contract: public-api — parseRemoteScriptDownloads' RemoteDownload.urlPath default
	it("defaults urlPath to empty string when the URL has no path segment (mutantId 6abb38e551f50f11)", () => {
		const out = parseRemoteScriptDownloads("curl -O https://example.com");
		expect(out).toHaveLength(1);
		// A mutated "" -> "Stryker was here!" default would make urlPath non-empty
		// AND would make the -O basename fallback pick up that literal string,
		// turning localPath from null into a truthy value.
		expect(out[0]?.urlPath).toBe("");
		expect(out[0]?.localPath).toBeNull();
	});
});

describe("parseRemoteScriptDownloads — negative (must not fire)", () => {
	// test-contract: public-api — parseRemoteScriptDownloads' empty-result contract
	it("returns an empty array (not a Stryker placeholder element) for a command with no curl/wget (mutantId 732a379dffa5ae3b)", () => {
		const out = parseRemoteScriptDownloads("echo hello world");
		expect(out).toEqual([]);
		expect(out).toHaveLength(0);
	});
});
