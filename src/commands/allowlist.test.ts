import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The admission screens (license + OSV advisory) are network-backed; the
// command tests pin the screen LOGIC, so the network module is mocked
// wholesale. registry-metadata.test.ts owns the wire-shape coverage.
const fetchRegistryMetadataMock = vi.fn();
const queryOsvAdvisoriesMock = vi.fn();
vi.mock("../harness/registry-metadata.js", () => ({
	fetchRegistryMetadata: (...args: unknown[]) => fetchRegistryMetadataMock(...args),
	queryOsvAdvisories: (...args: unknown[]) => queryOsvAdvisoriesMock(...args),
}));

import {
	addAllowlistCommand,
	listAllowlistCommand,
	removeAllowlistCommand,
	snapshotAllowlistCommand,
	verifyAllowlistCommand,
} from "./allowlist.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "allowlist-cmd-test-"));
	// Default to the happy path: permissively-licensed package, no advisories.
	fetchRegistryMetadataMock.mockReset();
	queryOsvAdvisoriesMock.mockReset();
	fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "1.0.0", license: "MIT" });
	queryOsvAdvisoriesMock.mockResolvedValue([]);
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	process.exitCode = 0;
});

function readAllowlistFile(): Record<string, unknown> | null {
	const p = join(workspace, ".interlinked", "package-allowlist.json");
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf-8"));
}

function capture(fn: () => void): string {
	const orig = process.stdout.write;
	let captured = "";
	(process.stdout as { write: typeof process.stdout.write }).write = ((
		chunk: string | Uint8Array,
	) => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as typeof process.stdout.write;
	try {
		fn();
	} finally {
		process.stdout.write = orig;
	}
	return captured;
}

async function captureAsync(fn: () => Promise<void>): Promise<string> {
	const orig = process.stdout.write;
	let captured = "";
	(process.stdout as { write: typeof process.stdout.write }).write = ((
		chunk: string | Uint8Array,
	) => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = orig;
	}
	return captured;
}

describe("addAllowlistCommand", () => {
	it("adds an entry to the per-ecosystem map and persists it", async () => {
		await addAllowlistCommand("npm", "lodash", { reason: "util", by: "qcody", cwd: workspace });
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, { approved_by: string; reason?: string }> };
		};
		expect(parsed.packages.npm.lodash.approved_by).toBe("qcody");
		expect(parsed.packages.npm.lodash.reason).toBe("util");
	});

	it("rejects an unknown ecosystem", async () => {
		await expect(
			addAllowlistCommand("badeco" as "npm", "foo", { by: "x", cwd: workspace }),
		).rejects.toThrow(/ecosystem/i);
	});

	it("refuses to approve a typosquat name (npm) without --force", async () => {
		await expect(
			addAllowlistCommand("npm", "chlk", { by: "x", cwd: workspace }),
		).rejects.toThrow(/typosquat|chalk|distance/i);
	});

	it("allows the typosquat name when --force is passed", async () => {
		await addAllowlistCommand("npm", "chlk", { by: "x", cwd: workspace, force: true });
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, unknown> };
		};
		expect(parsed.packages.npm.chlk).toBeDefined();
	});

	it("does not run typosquat detection for non-npm ecosystems", async () => {
		// 'requests' is exact-name popular, but 'requessts' is a typosquat by
		// npm-popular rules. PyPI gets a pass — different popular set, different
		// risk model; the npm typosquat list isn't relevant.
		await addAllowlistCommand("pypi", "chlk", { by: "x", cwd: workspace });
		const parsed = readAllowlistFile() as {
			packages: { pypi: Record<string, unknown> };
		};
		expect(parsed.packages.pypi.chlk).toBeDefined();
	});
});

describe("addAllowlistCommand — license screen", () => {
	it("records the registry-declared license on the entry", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "qcody", cwd: workspace });
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, { license?: string }> };
		};
		expect(parsed.packages.npm.lodash.license).toBe("MIT");
	});

	it("refuses a license outside the SPDX allowlist without --force", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "2.0.0", license: "AGPL-3.0" });
		await expect(
			addAllowlistCommand("npm", "copyleft-pkg", { by: "x", cwd: workspace }),
		).rejects.toThrow(/license "AGPL-3\.0".*allowlist/i);
		expect(readAllowlistFile()).toBeNull();
	});

	it("--force approves a disallowed license, records it, and says so", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "2.0.0", license: "AGPL-3.0" });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "copyleft-pkg", { by: "x", cwd: workspace, force: true }),
		);
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, { license?: string }> };
		};
		expect(parsed.packages.npm["copyleft-pkg"].license).toBe("AGPL-3.0");
		expect(out).toMatch(/--force/);
	});

	it("respects a committed license_allowlist override", async () => {
		// Seed an allowlist file whose license policy permits AGPL-3.0.
		const dir = join(workspace, ".interlinked");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package-allowlist.json"),
			JSON.stringify({
				version: 1,
				packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {} },
				lockfile_snapshots: {},
				license_allowlist: ["AGPL-3.0"],
			}),
		);
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "1.0.0", license: "AGPL-3.0" });
		await addAllowlistCommand("npm", "agpl-ok-here", { by: "x", cwd: workspace });
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, { license?: string }> };
		};
		expect(parsed.packages.npm["agpl-ok-here"].license).toBe("AGPL-3.0");
	});

	it("approves with a loud note when the license is unknown", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "1.0.0", license: undefined });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "mystery-pkg", { by: "x", cwd: workspace }),
		);
		expect(out).toMatch(/license.*unknown/i);
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, { license?: string }> };
		};
		expect(parsed.packages.npm["mystery-pkg"].license).toBeUndefined();
	});
});

describe("addAllowlistCommand — advisory screen", () => {
	it("refuses a package with open advisories against latest without --force", async () => {
		queryOsvAdvisoriesMock.mockResolvedValue([
			{ id: "GHSA-aaaa-bbbb", summary: "prototype pollution" },
		]);
		await expect(
			addAllowlistCommand("npm", "vuln-pkg", { by: "x", cwd: workspace }),
		).rejects.toThrow(/GHSA-aaaa-bbbb/);
		expect(readAllowlistFile()).toBeNull();
	});

	it("--force approves despite advisories and records the override note", async () => {
		queryOsvAdvisoriesMock.mockResolvedValue([{ id: "GHSA-aaaa-bbbb" }]);
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "vuln-pkg", { by: "x", cwd: workspace, force: true }),
		);
		expect(out).toMatch(/GHSA-aaaa-bbbb/);
		expect(out).toMatch(/--force/);
		expect(readAllowlistFile()).not.toBeNull();
	});

	it("queries OSV with the latest version the registry reported", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "3.2.1", license: "MIT" });
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		expect(queryOsvAdvisoriesMock).toHaveBeenCalledWith("npm", "lodash", "3.2.1");
	});

	it("approves with a note when OSV is unreachable (fail open, loud)", async () => {
		queryOsvAdvisoriesMock.mockResolvedValue(null);
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace }),
		);
		expect(out).toMatch(/OSV.*skipped/i);
		expect(readAllowlistFile()).not.toBeNull();
	});

	it("skips the advisory screen with a note when no latest version is known", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: undefined, license: "MIT" });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace }),
		);
		expect(out).toMatch(/no version to screen.*advisory screen skipped/i);
		expect(queryOsvAdvisoriesMock).not.toHaveBeenCalled();
	});

	it("skips license AND advisory (no version) when metadata is unavailable and no range is pinned", async () => {
		fetchRegistryMetadataMock.mockResolvedValue(null);
		const out = await captureAsync(() =>
			addAllowlistCommand("go", "github.com/pkg/errors", { by: "x", cwd: workspace }),
		);
		expect(out).toMatch(/license screen skipped/i);
		expect(out).toMatch(/advisory screen skipped/i);
		expect(queryOsvAdvisoriesMock).not.toHaveBeenCalled(); // no version to screen
		const parsed = readAllowlistFile() as {
			packages: { go: Record<string, { license?: string }> };
		};
		expect(parsed.packages.go["github.com/pkg/errors"]).toBeDefined();
		expect(parsed.packages.go["github.com/pkg/errors"].license).toBeUndefined();
	});

	// Round 7 (finding 2026-06): OSV needs no registry metadata. An exact
	// --version-range on Go (fetchRegistryMetadata always null) must still be
	// advisory-screened — previously the whole screen block sat behind
	// `meta !== null`, so a vulnerable pinned Go module was approved silently.
	it("STILL runs the OSV screen on an exact Go version pin when metadata is null", async () => {
		fetchRegistryMetadataMock.mockResolvedValue(null);
		queryOsvAdvisoriesMock.mockResolvedValue([{ id: "GO-2023-vuln" }]);
		await expect(
			addAllowlistCommand("go", "github.com/pkg/errors", {
				by: "x",
				cwd: workspace,
				versionRange: "0.9.1",
			}),
		).rejects.toThrow(/GO-2023-vuln/);
		expect(queryOsvAdvisoriesMock).toHaveBeenCalledWith("go", "github.com/pkg/errors", "0.9.1");
		expect(readAllowlistFile()).toBeNull(); // refused, nothing written
	});

	it("--force approves a vulnerable pinned Go module with a loud note (metadata null)", async () => {
		fetchRegistryMetadataMock.mockResolvedValue(null);
		queryOsvAdvisoriesMock.mockResolvedValue([{ id: "GO-2023-vuln" }]);
		const out = await captureAsync(() =>
			addAllowlistCommand("go", "github.com/pkg/errors", {
				by: "x",
				cwd: workspace,
				versionRange: "0.9.1",
				force: true,
			}),
		);
		expect(out).toMatch(/GO-2023-vuln/);
		expect(out).toMatch(/pinned 0\.9\.1/);
		expect(readAllowlistFile()).not.toBeNull();
	});
});

describe("removeAllowlistCommand", () => {
	it("removes an existing entry", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		removeAllowlistCommand("npm", "lodash", { cwd: workspace });
		const parsed = readAllowlistFile() as {
			packages: { npm: Record<string, unknown> };
		};
		expect(parsed.packages.npm.lodash).toBeUndefined();
	});

	it("is a no-op when removing a non-existent entry — does not throw, file unchanged", () => {
		// The implementation may either skip saving (file doesn't exist) or save
		// with the entry absent. Both states satisfy "non-existent entry stays
		// non-existent." Read with a sentinel to give one assertion regardless.
		const before = readAllowlistFile();
		removeAllowlistCommand("npm", "nonexistent", { cwd: workspace });
		const after = readAllowlistFile() ?? { packages: { npm: {} } };
		const npmRecord = (after as { packages: { npm: Record<string, unknown> } })
			.packages.npm;
		expect(npmRecord.nonexistent).toBeUndefined();
		expect(before).toBeNull();
	});
});

describe("listAllowlistCommand", () => {
	it("emits empty state when no entries exist", () => {
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/empty|no entries/i);
	});

	it("emits entries grouped by ecosystem, including the recorded license", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		await addAllowlistCommand("pypi", "requests", { by: "y", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/lodash/);
		expect(out).toMatch(/requests/);
		expect(out).toMatch(/npm/);
		expect(out).toMatch(/pypi/);
		expect(out).toMatch(/license MIT/);
	});

	it("supports --json output", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace, json: true }));
		const parsed = JSON.parse(out) as {
			packages: { npm: Record<string, unknown> };
		};
		expect(parsed.packages.npm.lodash).toBeDefined();
	});

	it("filters by ecosystem", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		await addAllowlistCommand("pypi", "requests", { by: "y", cwd: workspace });
		const out = capture(() =>
			listAllowlistCommand({ cwd: workspace, ecosystem: "npm" }),
		);
		expect(out).toMatch(/lodash/);
		expect(out).not.toMatch(/requests/);
	});
});

describe("snapshotAllowlistCommand", () => {
	it("snapshots all known manifest + lockfile files in cwd", () => {
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		writeFileSync(join(workspace, "package-lock.json"), '{"lockfileVersion":3}');
		snapshotAllowlistCommand({ cwd: workspace, by: "qcody", reason: "initial" });
		const parsed = readAllowlistFile() as {
			lockfile_snapshots: Record<
				string,
				{ sha256: string; approved_by: string }
			>;
		};
		expect(parsed.lockfile_snapshots["package.json"]).toBeDefined();
		expect(parsed.lockfile_snapshots["package-lock.json"]).toBeDefined();
		expect(parsed.lockfile_snapshots["package-lock.json"].sha256).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(parsed.lockfile_snapshots["package-lock.json"].approved_by).toBe("qcody");
	});

	it("supports --lockfile to snapshot a specific file only", () => {
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		writeFileSync(join(workspace, "package-lock.json"), '{"lockfileVersion":3}');
		snapshotAllowlistCommand({
			cwd: workspace,
			by: "qcody",
			lockfile: "package-lock.json",
		});
		const parsed = readAllowlistFile() as {
			lockfile_snapshots: Record<string, unknown>;
		};
		expect(parsed.lockfile_snapshots["package-lock.json"]).toBeDefined();
		expect(parsed.lockfile_snapshots["package.json"]).toBeUndefined();
	});

	it("is a no-op when no recognised files are present", () => {
		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));
		expect(out).toMatch(/no.*manifest|no.*lockfile|nothing/i);
	});

	it("auto-discovers and snapshots a variably-named *.csproj", () => {
		writeFileSync(
			join(workspace, "App.csproj"),
			'<Project><ItemGroup><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup></Project>',
		);
		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));
		expect(out).toMatch(/snapshotted/);
		expect(out).toMatch(/App\.csproj/);
	});

	it("recursively discovers and snapshots a NESTED *.csproj by relative path", () => {
		mkdirSync(join(workspace, "src", "Lib"), { recursive: true });
		writeFileSync(
			join(workspace, "src", "Lib", "Lib.csproj"),
			'<Project><ItemGroup><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup></Project>',
		);
		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));
		expect(out).toMatch(/src\/Lib\/Lib\.csproj/);
	});
});

describe("verifyAllowlistCommand", () => {
	it("reports clean when all manifest deps are allowlisted and snapshot matches", async () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { lodash: "^4.17.21" } }, null, 2),
		);
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		snapshotAllowlistCommand({ cwd: workspace, by: "x" });
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|ok|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("reports the unapproved deps in manifest", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { evil: "1" } }, null, 2),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil/);
		expect(out).toMatch(/unapproved|missing/i);
	});

	it("sets a non-zero exit code on unapproved deps so CI/scripts can gate", () => {
		// Found 2026-06-11: verify printed findings but always exited 0 —
		// un-gateable by CI, pre-push, or any script. Pin the contract.
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { evil: "1" } }, null, 2),
		);
		capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(process.exitCode).toBe(1);
	});

	it("walks requirements.txt (P2.8)", () => {
		writeFileSync(join(workspace, "requirements.txt"), "evil-py==1.0\n");
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-py/);
	});

	it("walks pyproject.toml (P2.8)", () => {
		writeFileSync(
			join(workspace, "pyproject.toml"),
			`[tool.poetry.dependencies]\npython = "^3.11"\nevil-poetry = "^1"\n`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-poetry/);
	});

	it("walks Cargo.toml (P2.8)", () => {
		writeFileSync(join(workspace, "Cargo.toml"), `[dependencies]\nevil-crate = "1"\n`);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-crate/);
	});

	it("walks Gemfile (P2.8)", () => {
		writeFileSync(join(workspace, "Gemfile"), `gem "evil-gem", "1"\n`);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-gem/);
	});

	it("walks go.mod (P2.8)", () => {
		writeFileSync(
			join(workspace, "go.mod"),
			`module x\ngo 1.21\nrequire github.com/evil/pkg v1.0.0\n`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/github\.com\/evil\/pkg/);
	});

	it("walks composer.json (G2)", () => {
		writeFileSync(
			join(workspace, "composer.json"),
			JSON.stringify({ require: { php: ">=8.1", "evil/pkg": "^1" } }, null, 2),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil\/pkg/);
		expect(out).toMatch(/composer/);
		expect(process.exitCode).toBe(1);
	});

	it("passes when the composer dep is allowlisted (G2)", async () => {
		await addAllowlistCommand("composer", "monolog/monolog", { by: "x", cwd: workspace });
		writeFileSync(
			join(workspace, "composer.json"),
			JSON.stringify({ require: { "monolog/monolog": "^3.0" } }, null, 2),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("walks pom.xml (maven) (G2)", () => {
		writeFileSync(
			join(workspace, "pom.xml"),
			`<project><dependencies><dependency>\n<groupId>com.evil</groupId><artifactId>payload</artifactId><version>1.0.0</version>\n</dependency></dependencies></project>`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/com\.evil:payload/);
		expect(out).toMatch(/maven/);
	});

	it("walks build.gradle (G2)", () => {
		writeFileSync(
			join(workspace, "build.gradle"),
			`dependencies {\n  implementation "com.evil:payload:1.0.0"\n}`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/com\.evil:payload/);
		expect(out).toMatch(/gradle/);
	});

	it("walks build.gradle.kts (G2)", () => {
		writeFileSync(
			join(workspace, "build.gradle.kts"),
			`dependencies {\n  implementation("io.evil:ktor-evil:2.3.7")\n}`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/io\.evil:ktor-evil/);
	});

	it("walks packages.config (nuget) (G2)", () => {
		writeFileSync(
			join(workspace, "packages.config"),
			`<packages>\n  <package id="Evil.Payload" version="1.0.0" />\n</packages>`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/Evil\.Payload/);
		expect(out).toMatch(/nuget/);
	});

	it("passes when the nuget package is allowlisted (G2)", async () => {
		await addAllowlistCommand("nuget", "Serilog", { by: "x", cwd: workspace });
		writeFileSync(
			join(workspace, "packages.config"),
			`<packages>\n  <package id="Serilog" version="3.1.1" />\n</packages>`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});
