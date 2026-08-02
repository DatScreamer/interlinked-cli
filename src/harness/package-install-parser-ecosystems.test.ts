// Direct unit tests for the composer / nuget / maven ecosystem parsers
// (added 2026-06-12). End-to-end dispatch through `parseInstallCommands` is
// covered in package-install-parser.test.ts; these pin the per-parser branch
// behavior — verb routing, spec classification, version extraction.

import { describe, expect, it } from "vitest";
import {
	isNpmVerb,
	parseBundle,
	parseCargo,
	parseComposer,
	parseGem,
	parseGo,
	parseMaven,
	parseNpmLike,
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

// ---------------------------------------------------------------------------
// npm / pnpm / yarn / bun — direct unit tests (added: this file's own parsers
// were previously only exercised end-to-end via parseInstallCommands in
// package-install-parser.test.ts; these pin the per-function branch behavior
// that the earlier describes above never touched, since they only cover the
// re-exported composer/nuget/maven parsers).
// ---------------------------------------------------------------------------

describe("isNpmVerb", () => {
	it("recognizes every add/sync/remove verb", () => {
		for (const v of ["install", "i", "add", "isntall", "ci", "uninstall", "remove", "rm", "un", "unlink"]) {
			expect(isNpmVerb(v)).toBe(true);
		}
	});

	it("rejects verbs it doesn't own", () => {
		for (const v of ["run", "test", "publish", "workspaces", "", "list"]) {
			expect(isNpmVerb(v)).toBe(false);
		}
	});
});

describe("parseNpmLike — verb routing and action", () => {
	it("install/i/add/isntall all resolve to add with a package", () => {
		for (const verb of ["install", "i", "add", "isntall"]) {
			const cmd = parseNpmLike("npm", ["npm", verb, "lodash"], {});
			expect(cmd?.ecosystem).toBe("npm");
			expect(cmd?.action).toBe("add");
			expect(cmd?.packages).toEqual([{ kind: "registry", name: "lodash" }]);
		}
	});

	it("yarn with a real verb and package is NOT forced into bare-sync (bareYarn requires exactly one token)", () => {
		const cmd = parseNpmLike("yarn", ["yarn", "add", "foo"], {});
		expect(cmd?.action).toBe("add");
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	it("uninstall/remove/rm/un/unlink all resolve to remove, packages still classified", () => {
		for (const verb of ["uninstall", "remove", "rm", "un", "unlink"]) {
			const cmd = parseNpmLike("npm", ["npm", verb, "lodash"], {});
			expect(cmd?.action).toBe("remove");
			expect(cmd?.packages).toEqual([{ kind: "registry", name: "lodash" }]);
		}
	});

	it("ci resolves to sync fromLockfile (npm always trusts the lockfile on ci)", () => {
		const cmd = parseNpmLike("npm", ["npm", "ci"], {});
		expect(cmd?.action).toBe("sync");
		expect(cmd?.fromLockfile).toBe(true);
		expect(cmd?.fromManifest).toBe(true);
		expect(cmd?.packages).toEqual([]);
		expect(cmd?.notes).toEqual([]);
	});

	it("an unrecognized verb returns null", () => {
		expect(parseNpmLike("npm", ["npm", "publish"], {})).toBeNull();
		expect(parseNpmLike("npm", ["npm", "run", "build"], {})).toBeNull();
	});

	it("bare `npm` (exactly one token) is NOT the bareYarn special case — it returns null", () => {
		// The bareYarn short-circuit is `bin === "yarn" && tokens.length === 1`;
		// a one-token call from a DIFFERENT manager must not trip it just because
		// the token count matches.
		expect(parseNpmLike("npm", ["npm"], {})).toBeNull();
		expect(parseNpmLike("pnpm", ["pnpm"], {})).toBeNull();
		expect(parseNpmLike("bun", ["bun"], {})).toBeNull();
	});

	it("bare `yarn` (exactly one token) syncs from manifest", () => {
		const cmd = parseNpmLike("yarn", ["yarn"], {});
		expect(cmd?.action).toBe("sync");
		expect(cmd?.fromManifest).toBe(true);
		expect(cmd?.packages).toEqual([]);
	});

	it("`yarn` followed by an unrecognized subcommand is NOT treated as install (bareYarn requires zero args)", () => {
		expect(parseNpmLike("yarn", ["yarn", "workspaces"], {})).toBeNull();
	});

	it("`yarn install` (recognized verb, not bare) still syncs via the 0-positional add branch", () => {
		const cmd = parseNpmLike("yarn", ["yarn", "install"], {});
		expect(cmd?.action).toBe("sync");
		expect(cmd?.fromManifest).toBe(true);
	});

	it("install with no args → sync from manifest, no lockfile unless a frozen flag was given", () => {
		const cmd = parseNpmLike("npm", ["npm", "install"], {});
		expect(cmd?.ecosystem).toBe("npm");
		expect(cmd?.action).toBe("sync");
		expect(cmd?.fromManifest).toBe(true);
		expect(cmd?.fromLockfile).toBe(false);
		expect(cmd?.packages).toEqual([]);
	});

	it("install with no args PLUS a frozen flag → fromLockfile true on the 0-positional add branch", () => {
		const cmd = parseNpmLike("pnpm", ["pnpm", "install", "--frozen-lockfile"], {});
		expect(cmd?.action).toBe("sync");
		expect(cmd?.fromLockfile).toBe(true);
	});

	it("add with a real package is NOT the sync special-case (fromManifest false)", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "lodash"], {});
		expect(cmd?.ecosystem).toBe("npm");
		expect(cmd?.action).toBe("add");
		expect(cmd?.fromManifest).toBe(false);
		expect(cmd?.fromLockfile).toBe(false);
		expect(cmd?.notes).toEqual([]);
	});

	it("uninstall with no package name is remove, not sync — fromManifest stays false despite zero positionals", () => {
		const cmd = parseNpmLike("npm", ["npm", "uninstall"], {});
		expect(cmd?.action).toBe("remove");
		expect(cmd?.fromManifest).toBe(false);
		expect(cmd?.packages).toEqual([]);
	});
});

describe("parseNpmLike — sync-from-lockfile decision (npmSyncFromLockfile)", () => {
	it("npm always trusts the lockfile on sync, even with an unexpected positional", () => {
		const cmd = parseNpmLike("npm", ["npm", "ci", "extra-arg"], {});
		expect(cmd?.fromLockfile).toBe(true);
		expect(cmd?.fromManifest).toBe(false);
		expect(cmd?.notes).toEqual(["unexpected positional args to npm ci"]);
	});

	it("pnpm trusts the lockfile on sync ONLY when there are no positionals", () => {
		const bare = parseNpmLike("pnpm", ["pnpm", "ci"], {});
		expect(bare?.fromLockfile).toBe(true);

		const withArg = parseNpmLike("pnpm", ["pnpm", "ci", "extra-arg"], {});
		expect(withArg?.fromLockfile).toBe(false);
		expect(withArg?.notes).toEqual(["unexpected positional args to pnpm ci"]);
	});

	it("an explicit frozen/immutable flag forces fromLockfile for any manager", () => {
		const cmd = parseNpmLike("bun", ["bun", "ci", "--frozen-lockfile"], {});
		expect(cmd?.fromLockfile).toBe(true);
	});

	it("bun/yarn on sync with no positionals and no frozen flag do NOT default to true (pnpm-only shortcut)", () => {
		const cmd = parseNpmLike("bun", ["bun", "ci"], {});
		expect(cmd?.fromLockfile).toBe(false);
	});
});

describe("parseNpmLike — flag scanning (scanNpmFlags / isNpmFrozenFlag)", () => {
	it("--registry <url> (separate form) captures customRegistry and is not a package", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "foo", "--registry", "http://evil.example"], {});
		expect(cmd?.customRegistry).toBe("http://evil.example");
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	it("--registry-url <url> (separate form) is recognized too", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "foo", "--registry-url", "http://evil.example"], {});
		expect(cmd?.customRegistry).toBe("http://evil.example");
	});

	it("--registry=<url> and --registry-url=<url> (glued forms)", () => {
		const a = parseNpmLike("npm", ["npm", "install", "foo", "--registry=http://evil.example"], {});
		expect(a?.customRegistry).toBe("http://evil.example");
		const b = parseNpmLike("npm", ["npm", "install", "foo", "--registry-url=http://evil.example"], {});
		expect(b?.customRegistry).toBe("http://evil.example");
	});

	it("the glued --registry= match is anchored to the START of the token (a garbage prefix does not count)", () => {
		// Without the leading `^`, a positional package name that merely CONTAINS
		// "--registry=" somewhere inside it would be misread as a registry override.
		const cmd = parseNpmLike("npm", ["npm", "install", "xx--registry=evil.example"], {});
		expect(cmd?.customRegistry).toBeUndefined();
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "xx--registry=evil.example" }]);
	});

	it("the glued --registry= match is anchored to the END of the token (trailing garbage after the value voids it)", () => {
		// Without the trailing `$`, an embedded line break followed by extra
		// content would still let the prefix up to the break register as the
		// registry value. Real bash args CAN carry a literal newline via
		// quoting, so this is a reachable evasion shape, not a contrived one.
		const cmd = parseNpmLike("npm", ["npm", "install", "foo", "--registry=evil.example\nHIDDEN"], {});
		expect(cmd?.customRegistry).toBeUndefined();
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	it("env-var registry override only applies when no inline --registry was given", () => {
		const withInline = parseNpmLike(
			"npm",
			["npm", "install", "foo", "--registry", "http://inline.example"],
			{ NPM_CONFIG_REGISTRY: "http://env.example" },
		);
		expect(withInline?.customRegistry).toBe("http://inline.example");

		const envOnly = parseNpmLike("npm", ["npm", "install", "foo"], {
			NPM_CONFIG_REGISTRY: "http://env.example",
		});
		expect(envOnly?.customRegistry).toBe("http://env.example");
	});

	it("every frozen/immutable flag sets frozenLockfile (checked via the 0-positional add branch)", () => {
		for (const flag of ["--frozen-lockfile", "--frozen", "--prefer-offline", "--immutable", "--no-update"]) {
			const cmd = parseNpmLike("npm", ["npm", "install", flag], {});
			expect(cmd?.fromLockfile).toBe(true);
		}
	});

	it("a non-frozen flag does not set fromLockfile", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "--verbose"], {});
		expect(cmd?.fromLockfile).toBe(false);
	});

	it("every NPM_FLAG_TAKES_VALUE flag swallows its value so it isn't mistaken for a package", () => {
		for (const flag of ["--prefix", "--cache", "--user-agent", "--workspace", "-w", "--save-prefix"]) {
			const cmd = parseNpmLike("npm", ["npm", "install", "foo", flag, "some-value"], {});
			expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo" }]);
		}
	});

	it("an unrecognized flag does NOT swallow its value — the value is (mis)parsed as a package", () => {
		// Documents current behavior: only the small NPM_FLAG_TAKES_VALUE set gets
		// look-ahead value consumption. Any other value-taking flag's value falls
		// through to the positional scan on the next iteration.
		const cmd = parseNpmLike("npm", ["npm", "install", "foo", "--loglevel", "silent"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "foo" },
			{ kind: "registry", name: "silent" },
		]);
	});

	it("a flag-looking token whose next token is another flag is not swallowed as a value", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "foo", "--workspace", "--verbose"], {});
		// "--verbose" starts with "-", so the look-ahead's non-flag test fails and
		// it is NOT consumed as --workspace's value; it's just dropped on its own
		// turn through the loop (still not a package).
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	it("the look-ahead's non-flag test does not accidentally swallow a REAL flag that starts with a dash", () => {
		// --workspace's next token here is "--registry", which starts with "-", so
		// the look-ahead must NOT treat it as --workspace's value. --registry then
		// gets its own normal turn through the loop and sets customRegistry.
		const cmd = parseNpmLike(
			"npm",
			["npm", "install", "foo", "--workspace", "--registry", "https://evil.example"],
			{},
		);
		expect(cmd?.customRegistry).toBe("https://evil.example");
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	it("the value look-ahead peeks at the NEXT token, not the previous one", () => {
		// If the previous token ("-x") were consulted instead of the next
		// ("myvalue"), the dash-prefixed previous token would make the look-ahead
		// fail and "myvalue" would wrongly fall through as a phantom package.
		const cmd = parseNpmLike("npm", ["npm", "install", "-x", "--prefix", "myvalue"], {});
		expect(cmd?.packages).toEqual([]);
	});

	it("a NPM_FLAG_TAKES_VALUE flag as the very last token has no value to swallow", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "foo", "--prefix"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	it("an empty-string value for a NPM_FLAG_TAKES_VALUE flag is swallowed as the value, not collected as a phantom package (regression: was 3 packages incl. an empty-name registry entry)", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "foo", "--prefix", "", "bar"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "foo" },
			{ kind: "registry", name: "bar" },
		]);
	});
});

describe("parseNpmLike — package spec classification (classifyNpmSpec)", () => {
	it("classifies tarball URLs (.tgz/.tar.gz/.zip), case-insensitively, with query/fragment", () => {
		for (const url of [
			"https://attacker.example/payload.tgz",
			"http://attacker.example/payload.tar.gz",
			"https://attacker.example/payload.zip",
			"https://attacker.example/payload.TGZ",
			"https://attacker.example/payload.tgz?x=1",
			"https://attacker.example/payload.tgz#frag",
		]) {
			const cmd = parseNpmLike("npm", ["npm", "install", url], {});
			expect(cmd?.packages).toEqual([{ kind: "tarball_url", url }]);
		}
	});

	it("classifies git URLs across every recognized prefix form", () => {
		for (const url of [
			"git+https://github.com/attacker/evil.git",
			"git+ssh://git@github.com/attacker/evil.git",
			"git+file:///local/evil",
			"github:attacker/evil",
			"gitlab:attacker/evil",
			"bitbucket:attacker/evil",
			"gist:1234567890abcdef",
			"https://github.com/attacker/evil.git",
			"https://github.com/attacker/evil.git#main",
			"http://github.com/attacker/evil.git",
			"git+http://github.com/attacker/evil.git",
		]) {
			const cmd = parseNpmLike("npm", ["npm", "install", url], {});
			expect(cmd?.packages).toEqual([{ kind: "git_url", url }]);
		}
	});

	it("the tarball regex is anchored to the START of the spec (a garbage prefix does not count)", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "xhttps://attacker.example/payload.tgz"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "xhttps://attacker.example/payload.tgz" },
		]);
	});

	it("the tarball regex is anchored to the END of the spec (trailing garbage after the extension voids it)", () => {
		const cmd = parseNpmLike(
			"npm",
			["npm", "install", "https://attacker.example/payload.tgz\nHIDDEN"],
			{},
		);
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "https://attacker.example/payload.tgz\nHIDDEN" },
		]);
	});

	it("the git-prefix regex (git+/github:/gitlab:/bitbucket:/gist:) is anchored to the START of the spec", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "xgithub:attacker/evil"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "xgithub:attacker/evil" }]);
	});

	it("the bare https://…git regex is anchored to the START of the spec", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "xhttps://github.com/attacker/evil.git"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "xhttps://github.com/attacker/evil.git" },
		]);
	});

	it("the bare https://…git regex is anchored to the END of the spec (trailing garbage after .git voids it)", () => {
		const cmd = parseNpmLike(
			"npm",
			["npm", "install", "https://github.com/attacker/evil.git\nHIDDEN"],
			{},
		);
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "https://github.com/attacker/evil.git\nHIDDEN" },
		]);
	});

	it("classifies a file: spec, stripping the file: prefix into path", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "file:../local-tarball.tgz"], {});
		expect(cmd?.packages).toEqual([{ kind: "file_url", path: "../local-tarball.tgz" }]);
	});

	it("classifies local-path specs (./ ../ / ~/)", () => {
		for (const spec of ["./my-local-pkg", "../sibling-pkg", "/abs/path/pkg", "~/home-pkg"]) {
			const cmd = parseNpmLike("npm", ["npm", "install", spec], {});
			expect(cmd?.packages).toEqual([{ kind: "local_path", path: spec }]);
		}
	});

	it("classifies a scoped package with a version (@scope/name@version)", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "@types/node@22.5.0"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "@types/node", version: "22.5.0" },
		]);
	});

	it("classifies a bare scoped package with no version", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "@scope/lib"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "@scope/lib" }]);
	});

	it("classifies a malformed scoped spec with no slash as its own literal name (outer fallback branch)", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "@bad"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "@bad" }]);
	});

	it("a scoped spec where the version-delimiter @ is the very first char after the slash", () => {
		// rest = "@ver" (indexOf("@") === 0 there) — the inner "at < 0" branch must
		// still fire (0 is not < 0), NOT the "at <= 0" reading.
		const cmd = parseNpmLike("npm", ["npm", "install", "@scope/@ver"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "@scope/", version: "ver" }]);
	});

	it("classifies an unscoped package with a version", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "lodash@4.17.21"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "lodash", version: "4.17.21" }]);
	});

	it("classifies a bare unscoped package with no version", () => {
		const cmd = parseNpmLike("npm", ["npm", "install", "lodash"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "lodash" }]);
	});
});

// ---------------------------------------------------------------------------
// cargo
// ---------------------------------------------------------------------------

describe("parseCargo — verb routing", () => {
	it("dispatches add/install/sync verbs to the right handler", () => {
		expect(parseCargo(["cargo", "add", "serde"], {})?.action).toBe("add");
		expect(parseCargo(["cargo", "install", "ripgrep"], {})?.action).toBe("install_global");
	});

	it("every cargo sync verb (build/test/run/check) resolves to a manifest sync", () => {
		for (const sub of ["build", "test", "run", "check"]) {
			const cmd = parseCargo(["cargo", sub], {});
			expect(cmd?.action).toBe("sync");
			expect(cmd?.fromManifest).toBe(true);
			expect(cmd?.manifestFile).toBe("Cargo.toml");
		}
	});

	it("returns null for a non-install, non-sync cargo subcommand", () => {
		expect(parseCargo(["cargo", "doc"], {})).toBeNull();
		expect(parseCargo(["cargo", "new", "foo"], {})).toBeNull();
		expect(parseCargo(["cargo"], {})).toBeNull();
	});
});

describe("parseCargo add — flag scanning and spec classification", () => {
	it("plain crate name, no flags", () => {
		const cmd = parseCargo(["cargo", "add", "serde"], {});
		expect(cmd?.ecosystem).toBe("cargo");
		expect(cmd?.manager).toBe("cargo");
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "serde", version: undefined }]);
		expect(cmd?.fromLockfile).toBe(false);
		expect(cmd?.fromManifest).toBe(false);
		expect(cmd?.notes).toEqual([]);
	});

	it("a crate spec literally starting with @ does not split at the leading char (no npm-style scope handling)", () => {
		const cmd = parseCargo(["cargo", "add", "@something"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "@something", version: undefined }]);
	});

	it("--vers=/--version= glued-regex anchors: a garbage prefix does not count as a match", () => {
		const cmd = parseCargo(["cargo", "add", "serde", "xx--vers=1.0.0"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "serde", version: undefined },
			{ kind: "registry", name: "xx--vers", version: undefined },
		]);
	});

	it("--vers=/--version= glued-regex anchors: trailing garbage after the value voids the match", () => {
		const cmd = parseCargo(["cargo", "add", "serde", "--vers=1.0.0\nHIDDEN"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "serde", version: undefined }]);
	});

	it("glued crate@version pin lands on the spec, not as a second crate", () => {
		const cmd = parseCargo(["cargo", "add", "serde@1.0.0"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
	});

	it("--vers <v> and --version <v> (separate forms) both capture the pin", () => {
		const a = parseCargo(["cargo", "add", "serde", "--vers", "1.0.0"], {});
		expect(a?.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
		const b = parseCargo(["cargo", "add", "serde", "--version", "1.0.0"], {});
		expect(b?.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
	});

	it("--vers=<v> and --version=<v> (glued forms) both capture the pin", () => {
		const a = parseCargo(["cargo", "add", "serde", "--vers=1.0.0"], {});
		expect(a?.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
		const b = parseCargo(["cargo", "add", "serde", "--version=1.0.0"], {});
		expect(b?.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
	});

	it("--git <url> is folded into a positional and yields a git_url spec (only cargo add accepts it)", () => {
		const cmd = parseCargo(["cargo", "add", "--git", "https://github.com/foo/bar", "foo"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "git_url", url: "https://github.com/foo/bar" },
			{ kind: "registry", name: "foo", version: undefined },
		]);
	});

	it("--registry <url> captures a custom registry", () => {
		const cmd = parseCargo(["cargo", "add", "serde", "--registry", "https://evil.example"], {});
		expect(cmd?.customRegistry).toBe("https://evil.example");
	});

	it("falls back to a CARGO_REGISTRIES_*_INDEX env var when no --registry flag is given", () => {
		const cmd = parseCargo(["cargo", "add", "serde"], { CARGO_REGISTRIES_FOO_INDEX: "https://evil.example" });
		expect(cmd?.customRegistry).toBe("https://evil.example");
	});

	it("an inline --registry wins over the env var", () => {
		const cmd = parseCargo(
			["cargo", "add", "serde", "--registry", "https://inline.example"],
			{ CARGO_REGISTRIES_FOO_INDEX: "https://env.example" },
		);
		expect(cmd?.customRegistry).toBe("https://inline.example");
	});

	it("an unrecognized dash flag is dropped without consuming the next token", () => {
		const cmd = parseCargo(["cargo", "add", "serde", "-x", "extra"], {});
		expect(cmd?.packages.map((p) => (p.kind === "registry" ? p.name : null))).toEqual([
			"serde",
			"extra",
		]);
	});

	it("a crate name with no version match falls back to the literal spec", () => {
		const cmd = parseCargo(["cargo", "add", "!bad"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "!bad", version: undefined }]);
	});

	it("a local-path spec (./  ../  /  or exactly .)", () => {
		for (const spec of ["./local-crate", "../sibling-crate", "/abs/crate", "."]) {
			const cmd = parseCargo(["cargo", "add", spec], {});
			expect(cmd?.packages).toEqual([{ kind: "local_path", path: spec }]);
		}
	});
});

describe("parseCargo install — --git is NOT folded in (install behavior unchanged)", () => {
	it("cargo install does not accept --git as a positional-folding flag", () => {
		const cmd = parseCargo(["cargo", "install", "ripgrep", "--git", "https://github.com/x/y"], {});
		expect(cmd?.ecosystem).toBe("cargo");
		expect(cmd?.manager).toBe("cargo");
		expect(cmd?.packages.some((p) => p.kind === "git_url")).toBe(false);
		expect(cmd?.customRegistry).toBeUndefined();
		expect(cmd?.fromLockfile).toBe(false);
		expect(cmd?.fromManifest).toBe(false);
		expect(cmd?.notes).toEqual([]);
	});

	it("crate@version pin still works for install", () => {
		const cmd = parseCargo(["cargo", "install", "ripgrep@13.0.0"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "ripgrep", version: "13.0.0" }]);
	});

	it("falls back to a CARGO_REGISTRIES_*_INDEX env var for install too (nullish, not falsy, coalescing)", () => {
		const cmd = parseCargo(["cargo", "install", "ripgrep"], {
			CARGO_REGISTRIES_FOO_INDEX: "https://evil.example",
		});
		expect(cmd?.customRegistry).toBe("https://evil.example");
	});
});

describe("parseCargo sync (build/test/run/check) — lockfile flags", () => {
	it("--locked sets fromLockfile", () => {
		const cmd = parseCargo(["cargo", "build", "--locked"], {});
		expect(cmd?.ecosystem).toBe("cargo");
		expect(cmd?.manager).toBe("cargo");
		expect(cmd?.fromLockfile).toBe(true);
		expect(cmd?.packages).toEqual([]);
		expect(cmd?.notes).toEqual([]);
	});

	it("--frozen sets fromLockfile", () => {
		expect(parseCargo(["cargo", "test", "--frozen"], {})?.fromLockfile).toBe(true);
	});

	it("no lockfile flag → fromLockfile false", () => {
		expect(parseCargo(["cargo", "run"], {})?.fromLockfile).toBe(false);
	});

	it("picks up the registry env var on sync too", () => {
		const cmd = parseCargo(["cargo", "check"], { CARGO_REGISTRIES_FOO_INDEX: "https://evil.example" });
		expect(cmd?.customRegistry).toBe("https://evil.example");
	});
});

// ---------------------------------------------------------------------------
// gem / bundle
// ---------------------------------------------------------------------------

describe("parseGem", () => {
	it("only the install verb is handled", () => {
		expect(parseGem(["gem", "list"], {})).toBeNull();
		expect(parseGem(["gem", "uninstall", "rails"], {})).toBeNull();
	});

	it("no subcommand at all also returns null (tokens[1] fallback)", () => {
		expect(parseGem(["gem"], {})).toBeNull();
	});

	it("plain install, no flags", () => {
		const cmd = parseGem(["gem", "install", "rails"], {});
		expect(cmd?.ecosystem).toBe("rubygems");
		expect(cmd?.manager).toBe("gem");
		expect(cmd?.action).toBe("install_global");
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "rails", version: undefined }]);
		expect(cmd?.fromLockfile).toBe(false);
		expect(cmd?.fromManifest).toBe(false);
		expect(cmd?.notes).toEqual([]);
	});

	it("a gem spec starting with a literal colon does not split at position 0", () => {
		// colon = 0 there — the "colon > 0" branch must NOT fire (0 is not > 0).
		const cmd = parseGem(["gem", "install", ":1.2.3"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: ":1.2.3", version: undefined }]);
	});

	it("-v=/--version= glued-regex anchors: a garbage prefix does not count as a match", () => {
		const cmd = parseGem(["gem", "install", "rails", "xx-v=1.2.3"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "rails", version: undefined },
			{ kind: "registry", name: "xx-v=1.2.3", version: undefined },
		]);
	});

	it("-v=/--version= glued-regex anchors: trailing garbage after the value voids the match", () => {
		const cmd = parseGem(["gem", "install", "rails", "-v=1.2.3\nHIDDEN"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "rails", version: undefined }]);
	});

	it("every --source flag form captures a custom registry", () => {
		for (const flag of ["--source", "-s", "--add-source"]) {
			const cmd = parseGem(["gem", "install", "rails", flag, "https://evil.example"], {});
			expect(cmd?.customRegistry).toBe("https://evil.example");
		}
	});

	it("-v and --version (separate forms) pin the version, no phantom package", () => {
		const a = parseGem(["gem", "install", "rails", "-v", "7.1.0"], {});
		expect(a?.packages).toEqual([{ kind: "registry", name: "rails", version: "7.1.0" }]);
		const b = parseGem(["gem", "install", "rails", "--version", "7.1.0"], {});
		expect(b?.packages).toEqual([{ kind: "registry", name: "rails", version: "7.1.0" }]);
	});

	it("-v= and --version= (glued forms) pin the version", () => {
		const a = parseGem(["gem", "install", "rails", "-v=7.1.0"], {});
		expect(a?.packages).toEqual([{ kind: "registry", name: "rails", version: "7.1.0" }]);
		const b = parseGem(["gem", "install", "rails", "--version=7.1.0"], {});
		expect(b?.packages).toEqual([{ kind: "registry", name: "rails", version: "7.1.0" }]);
	});

	it("a gem's own glued name:version colon form wins over a sibling -v flag", () => {
		const cmd = parseGem(["gem", "install", "rails:7.0.0", "-v", "7.1.0"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "rails", version: "7.0.0" }]);
	});

	it("falls back to GEM_SOURCE env var when no --source flag is given", () => {
		const cmd = parseGem(["gem", "install", "rails"], { GEM_SOURCE: "https://evil.example" });
		expect(cmd?.customRegistry).toBe("https://evil.example");
	});

	it("an inline --source wins over the GEM_SOURCE env var", () => {
		const cmd = parseGem(
			["gem", "install", "rails", "--source", "https://inline.example"],
			{ GEM_SOURCE: "https://env.example" },
		);
		expect(cmd?.customRegistry).toBe("https://inline.example");
	});

	it("an unrecognized dash flag is dropped without consuming the next token", () => {
		const cmd = parseGem(["gem", "install", "rails", "-q", "extra"], {});
		expect(cmd?.packages.map((p) => (p.kind === "registry" ? p.name : null))).toEqual([
			"rails",
			"extra",
		]);
	});
});

describe("parseBundle", () => {
	it("install → sync from manifest, no lockfile by default", () => {
		const cmd = parseBundle(["bundle", "install"], {});
		expect(cmd?.ecosystem).toBe("rubygems");
		expect(cmd?.manager).toBe("bundle");
		expect(cmd?.action).toBe("sync");
		expect(cmd?.fromManifest).toBe(true);
		expect(cmd?.manifestFile).toBe("Gemfile");
		expect(cmd?.fromLockfile).toBe(false);
		expect(cmd?.packages).toEqual([]);
		expect(cmd?.notes).toEqual([]);
	});

	it("install --frozen and install --deployment both set fromLockfile", () => {
		expect(parseBundle(["bundle", "install", "--frozen"], {})?.fromLockfile).toBe(true);
		expect(parseBundle(["bundle", "install", "--deployment"], {})?.fromLockfile).toBe(true);
	});

	it("add filters out flags and keeps only positional gem names", () => {
		const cmd = parseBundle(["bundle", "add", "rails", "--skip-install"], {});
		expect(cmd?.ecosystem).toBe("rubygems");
		expect(cmd?.manager).toBe("bundle");
		expect(cmd?.action).toBe("add");
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "rails" }]);
		expect(cmd?.fromLockfile).toBe(false);
		expect(cmd?.fromManifest).toBe(false);
		expect(cmd?.notes).toEqual([]);
	});

	it("picks up the GEM_SOURCE env var on both install and add", () => {
		expect(parseBundle(["bundle", "install"], { GEM_SOURCE: "https://evil.example" })?.customRegistry).toBe(
			"https://evil.example",
		);
		expect(parseBundle(["bundle", "add", "rails"], { GEM_SOURCE: "https://evil.example" })?.customRegistry).toBe(
			"https://evil.example",
		);
	});

	it("returns null for any other bundle subcommand, including no subcommand at all", () => {
		expect(parseBundle(["bundle", "exec", "rspec"], {})).toBeNull();
		expect(parseBundle(["bundle"], {})).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// go get / go install
// ---------------------------------------------------------------------------

describe("parseGo", () => {
	it("get → add", () => {
		const cmd = parseGo(["go", "get", "github.com/gin-gonic/gin"], {});
		expect(cmd?.ecosystem).toBe("go");
		expect(cmd?.manager).toBe("go");
		expect(cmd?.action).toBe("add");
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "github.com/gin-gonic/gin" }]);
		expect(cmd?.fromLockfile).toBe(false);
		expect(cmd?.fromManifest).toBe(false);
		expect(cmd?.notes).toEqual([]);
	});

	it("install → install_global", () => {
		const cmd = parseGo(["go", "install", "github.com/spf13/cobra-cli@latest"], {});
		expect(cmd?.manager).toBe("go");
		expect(cmd?.action).toBe("install_global");
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "github.com/spf13/cobra-cli", version: "latest" },
		]);
	});

	it("returns null for any other go subcommand", () => {
		expect(parseGo(["go", "build"], {})).toBeNull();
		expect(parseGo(["go"], {})).toBeNull();
	});

	it("filters out dash flags from positionals (e.g. `go get -u module`)", () => {
		const cmd = parseGo(["go", "get", "-u", "github.com/gin-gonic/gin"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "github.com/gin-gonic/gin" }]);
	});

	it("splits on the LAST @ (a module path containing an earlier @ still resolves the trailing version)", () => {
		const cmd = parseGo(["go", "get", "github.com/foo@bar@v1.0.0"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "github.com/foo@bar", version: "v1.0.0" },
		]);
	});

	it("a module path starting with @ (no version split, since the @ isn't past index 0)", () => {
		const cmd = parseGo(["go", "get", "@bare"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "@bare" }]);
	});

	it("falls back to the GOPROXY env var for customRegistry", () => {
		const cmd = parseGo(["go", "get", "github.com/gin-gonic/gin"], { GOPROXY: "https://evil.example" });
		expect(cmd?.customRegistry).toBe("https://evil.example");
	});
});
