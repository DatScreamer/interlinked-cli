import { describe, expect, it } from "vitest";
import {
	extractComposerDeps,
	extractGradleDeps,
	extractGradleVersionCatalogDeps,
	extractNugetDeps,
	extractPomDeps,
} from "./manifest-dep-extract.js";

describe("manifest dependency extractor mutation contracts", () => {
	// test-contract: boundary — malformed JSON and JSON scalar roots must be safe empty public results
	it("rejects malformed, null, and scalar Composer roots", () => {
		expect(extractComposerDeps("{").size).toBe(0);
		expect(extractComposerDeps("null").size).toBe(0);
		expect(extractComposerDeps("42").size).toBe(0);
		expect(extractComposerDeps(JSON.stringify({ require: "not-an-object" })).size).toBe(0);
	});

	// test-contract: security — all supported Composer platform pseudo-package prefixes are excluded while a suffix near-miss remains
	it("filters every Composer platform prefix from both requirement blocks", () => {
		const deps = extractComposerDeps(JSON.stringify({
			require: {
				php: "*",
				hhvm: "*",
				"ext-json": "*",
				"lib-xml": "*",
				"composer-runtime-api": "*",
				"php-64bit": "*",
				"vendor/php": "1.0",
			},
			"require-dev": { "vendor/lib-": "1.0", "vendor/composer-": "1.0" },
		}));
		expect([...deps.keys()]).toEqual(["vendor/php", "vendor/lib-", "vendor/composer-"]);
	});

	// test-contract: boundary — a dependency element with only one coordinate is ignored rather than creating an incomplete key
	it("skips POM dependencies missing either groupId or artifactId", () => {
		const pom = `<project><dependencies>
			<dependency><groupId>org.only</groupId><version>1</version></dependency>
			<dependency><artifactId>only-artifact</artifactId><version>2</version></dependency>
			<dependency><groupId>org.ok</groupId><artifactId>complete</artifactId></dependency>
		</dependencies></project>`;
		expect([...extractPomDeps(pom).entries()]).toEqual([["org.ok:complete", ""]]);
	});

	// test-contract: public-api — dependency attributes and coordinates may contain harmless XML attributes before the body
	it("recognizes POM dependency elements with attributes and preserves absent version as empty", () => {
		const deps = extractPomDeps('<dependency scope="runtime"><groupId>g</groupId><artifactId>a</artifactId></dependency>');
		expect(deps.get("g:a")).toBe("");
	});

	// test-contract: invariant — Gradle map notation accepts no whitespace around either colon while requiring both keys
	it("parses compact Gradle map notation and returns its empty version", () => {
		const deps = extractGradleDeps("implementation group:'g',name:'a'");
		expect(deps.get("g:a")).toBe("");
	});

	// test-contract: boundary — Gradle map notation must not synthesize a dependency from a lone group or name
	it("rejects incomplete Gradle map pairs", () => {
		expect(extractGradleDeps("api group:'g'\napi name:'a'").size).toBe(0);
	});

	// test-contract: security — only the anchored [libraries] TOML table is dependency-bearing
	it("does not activate on headings that merely contain the libraries token", () => {
		const content = `prefix[libraries]\nevil = { module = "bad:leak" }\n[plugins]\np = { module = "bad:plugin" }`;
		expect(extractGradleVersionCatalogDeps(content).size).toBe(0);
	});

	// test-contract: invariant — TOML table state, comments, blank lines, and indentation are handled by public extraction
	it("trims library lines, ignores comments and blanks, and stops at the next table", () => {
		const content = `[libraries]\n\n  # fake = { module = "bad:comment" }\n  good = { module="ok:dep" }\n[versions]\n  other = { module = "bad:outside" }`;
		expect([...extractGradleVersionCatalogDeps(content).entries()]).toEqual([["ok:dep", ""]]);
	});

	// test-contract: boundary — catalog group/name notation requires both fields and accepts compact equals spacing
	it("rejects incomplete catalog group/name entries", () => {
		const content = `[libraries]\nonly-group = { group="g" }\nonly-name = { name="n" }\ncomplete = { group="g", name="n" }`;
		expect([...extractGradleVersionCatalogDeps(content).entries()]).toEqual([["g:n", ""]]);
	});

	// test-contract: public-api — legacy NuGet package tags support non-self-closing and multiline forms
	it("extracts legacy NuGet package attributes across tag layout variants", () => {
		const content = `<packages><package\n id = 'Legacy'\n version = '1.2'\n></package><package id='Second' version='2.0' /></packages>`;
		expect([...extractNugetDeps(content).entries()]).toEqual([["Legacy", "1.2"], ["Second", "2.0"]]);
	});

	// test-contract: security — attribute names must be exact and malformed id/version attributes must not be accepted as aliases
	it("does not confuse extended NuGet attribute names with id or version", () => {
		const content = `<package idExtra="wrong" versionExtra="wrong" /><PackageReference IncludeExtra="wrong" VersionExtra="wrong" />`;
		expect(extractNugetDeps(content).size).toBe(0);
	});

	// test-contract: boundary — PackageReference supports multiline child Version and ignores references without Include
	it("extracts multiline PackageReference child versions only when Include exists", () => {
		const content = `<Project><PackageReference Include="Good">\n  <Version>3.4.5</Version>\n</PackageReference>\n<PackageReference><Version>bad</Version></PackageReference></Project>`;
		const deps = extractNugetDeps(content);
		expect([...deps.entries()]).toEqual([["Good", "3.4.5"]]);
	});
});
