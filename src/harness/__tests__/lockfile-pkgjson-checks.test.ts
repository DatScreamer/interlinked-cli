import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLockfileDrift, checkPackageJsonConsistency } from "../quality-checks.js";

// ===========================================
// Lockfile Drift Detection
// ===========================================

describe("checkLockfileDrift", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
		tmpDir = mkdtempSync(join(tmpdir(), "lockfile-drift-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.useRealTimers();
	});

	it("returns not drifted when lockfile is newer than manifest", () => {
		const manifest = join(tmpDir, "package.json");
		const lockfile = join(tmpDir, "package-lock.json");
		writeFileSync(manifest, "{}");
		// Ensure lockfile is written after manifest
		const now = new Date();
		utimesSync(manifest, now, new Date(now.getTime() - 5000));
		writeFileSync(lockfile, "{}");
		utimesSync(lockfile, now, now);

		const result = checkLockfileDrift(manifest);
		expect(result.drifted).toBe(false);
		expect(result.reason).toBe("none");
		expect(result.lockfile).toBe("package-lock.json");
	});

	// Helper: age the manifest mtime so it's outside the grace window (default 5s).
	// Tests that want to exercise "genuine" drift must use this — otherwise the
	// grace window suppresses the finding.
	function ageManifest(path: string, secondsAgo = 60): void {
		const past = new Date(Date.now() - secondsAgo * 1000);
		utimesSync(path, past, past);
	}

	it("returns drifted when manifest is newer than lockfile", () => {
		const manifest = join(tmpDir, "package.json");
		const lockfile = join(tmpDir, "package-lock.json");
		writeFileSync(lockfile, "{}");
		const past = new Date(Date.now() - 120_000);
		utimesSync(lockfile, past, past);
		writeFileSync(manifest, "{}");
		ageManifest(manifest, 60);

		const result = checkLockfileDrift(manifest);
		expect(result.drifted).toBe(true);
		expect(result.reason).toBe("stale");
		expect(result.lockfile).toBe("package-lock.json");
	});

	it("returns missing when no lockfile exists", () => {
		const manifest = join(tmpDir, "package.json");
		writeFileSync(manifest, "{}");
		ageManifest(manifest, 60);

		const result = checkLockfileDrift(manifest);
		expect(result.drifted).toBe(true);
		expect(result.reason).toBe("missing");
		expect(result.lockfile).toBeUndefined();
	});

	it("prefers package-lock.json over yarn.lock", () => {
		const manifest = join(tmpDir, "package.json");
		const npmLock = join(tmpDir, "package-lock.json");
		const yarnLock = join(tmpDir, "yarn.lock");
		writeFileSync(manifest, "{}");
		const past = new Date(Date.now() - 10000);
		utimesSync(manifest, past, past);
		writeFileSync(npmLock, "{}");
		writeFileSync(yarnLock, "{}");

		const result = checkLockfileDrift(manifest);
		expect(result.lockfile).toBe("package-lock.json");
	});

	it("falls back to yarn.lock when package-lock.json missing", () => {
		const manifest = join(tmpDir, "package.json");
		const yarnLock = join(tmpDir, "yarn.lock");
		writeFileSync(manifest, "{}");
		const past = new Date(Date.now() - 10000);
		utimesSync(manifest, past, past);
		writeFileSync(yarnLock, "{}");

		const result = checkLockfileDrift(manifest);
		expect(result.lockfile).toBe("yarn.lock");
	});

	it("handles Cargo.toml → Cargo.lock", () => {
		const manifest = join(tmpDir, "Cargo.toml");
		const lockfile = join(tmpDir, "Cargo.lock");
		writeFileSync(lockfile, "");
		const past = new Date(Date.now() - 120_000);
		utimesSync(lockfile, past, past);
		writeFileSync(manifest, "[package]");
		ageManifest(manifest, 60);

		const result = checkLockfileDrift(manifest);
		expect(result.drifted).toBe(true);
		expect(result.reason).toBe("stale");
		expect(result.manifest).toBe("Cargo.toml");
		expect(result.lockfile).toBe("Cargo.lock");
	});

	it("handles pyproject.toml → poetry.lock", () => {
		const manifest = join(tmpDir, "pyproject.toml");
		const lockfile = join(tmpDir, "poetry.lock");
		writeFileSync(lockfile, "");
		const past = new Date(Date.now() - 120_000);
		utimesSync(lockfile, past, past);
		writeFileSync(manifest, "[project]");
		ageManifest(manifest, 60);

		const result = checkLockfileDrift(manifest);
		expect(result.drifted).toBe(true);
		expect(result.manifest).toBe("pyproject.toml");
		expect(result.lockfile).toBe("poetry.lock");
	});

	it("returns none for unknown manifest files", () => {
		const manifest = join(tmpDir, "build.gradle");
		writeFileSync(manifest, "");

		const result = checkLockfileDrift(manifest);
		expect(result.drifted).toBe(false);
		expect(result.reason).toBe("none");
	});

	// ===========================================
	// Grace window — edit→regen noise suppression
	// ===========================================

	it("suppresses stale drift when manifest was just edited (within grace window)", () => {
		// Simulates the exact noise scenario: agent edits package.json, hook fires
		// PostToolUse immediately. Without the grace window, this produces a
		// false "lockfile is stale" warning before `npm install` has had a chance
		// to run.
		const manifest = join(tmpDir, "package.json");
		const lockfile = join(tmpDir, "package-lock.json");
		writeFileSync(lockfile, "{}");
		const past = new Date(Date.now() - 120_000);
		utimesSync(lockfile, past, past);
		writeFileSync(manifest, "{}");
		// manifest mtime = real-now → within default 5s grace window

		const result = checkLockfileDrift(manifest);
		expect(result.drifted).toBe(false);
		expect(result.reason).toBe("grace");
		expect(result.lockfile).toBe("package-lock.json");
	});

	it("suppresses missing-lockfile warning when manifest was just created", () => {
		// Agent runs `npm init` or writes a new package.json. The lockfile
		// doesn't exist yet, but the user is about to run install. Don't warn.
		const manifest = join(tmpDir, "package.json");
		writeFileSync(manifest, "{}");

		const result = checkLockfileDrift(manifest);
		expect(result.drifted).toBe(false);
		expect(result.reason).toBe("grace");
	});

	it("fires stale drift once the grace window has elapsed", () => {
		// Later PostToolUse event (e.g. >5s after the manifest edit): if the
		// user still hasn't regenerated the lockfile, drift fires normally.
		const manifest = join(tmpDir, "package.json");
		const lockfile = join(tmpDir, "package-lock.json");
		writeFileSync(lockfile, "{}");
		const past = new Date(Date.now() - 120_000);
		utimesSync(lockfile, past, past);
		writeFileSync(manifest, "{}");
		ageManifest(manifest, 30); // 30s ago — well outside 5s grace

		const result = checkLockfileDrift(manifest);
		expect(result.drifted).toBe(true);
		expect(result.reason).toBe("stale");
	});

	it("respects a custom grace window override", () => {
		const manifest = join(tmpDir, "package.json");
		const lockfile = join(tmpDir, "package-lock.json");
		writeFileSync(lockfile, "{}");
		const past = new Date(Date.now() - 120_000);
		utimesSync(lockfile, past, past);
		writeFileSync(manifest, "{}");
		ageManifest(manifest, 10); // 10s ago

		// Default 5s grace: outside window → stale fires
		const defaultResult = checkLockfileDrift(manifest);
		expect(defaultResult.reason).toBe("stale");

		// Custom 30s grace: inside window → suppressed
		const customResult = checkLockfileDrift(manifest, { graceWindowMs: 30_000 });
		expect(customResult.drifted).toBe(false);
		expect(customResult.reason).toBe("grace");
	});

	it("full edit→regen sequence: initial edit suppressed, follow-up clean", () => {
		// This is the end-to-end before/after: two PostToolUse events separated
		// by a successful regen. Before the fix: 2 warnings (edit + stale-until-regen).
		// After the fix: 0 warnings.
		//
		// Note: this test doesn't rely on vi.useFakeTimers() for mtime comparisons
		// because filesystem mtimes always reflect wall-clock time. We pass an
		// explicit `now` override to checkLockfileDrift so the grace check runs
		// against the real mtime, not the faked Date.now().
		const manifest = join(tmpDir, "package.json");
		const lockfile = join(tmpDir, "package-lock.json");

		// Simulate an initial committed lockfile state (both files old).
		writeFileSync(manifest, "{}");
		writeFileSync(lockfile, "{}");

		// Turn 1: agent edits package.json. mtime bumps to real wall-clock now.
		writeFileSync(manifest, '{"name":"x"}');
		const manifestEditedAt = statSync(manifest).mtimeMs;
		// Age the lockfile to 2 min before the manifest edit (unambiguously stale).
		const past = new Date(manifestEditedAt - 120_000);
		utimesSync(lockfile, past, past);

		const duringEdit = checkLockfileDrift(manifest, { now: manifestEditedAt + 500 });
		expect(duringEdit.drifted).toBe(false);
		expect(duringEdit.reason).toBe("grace");

		// Turn 2: agent runs `npm install` → lockfile mtime bumps past manifest mtime.
		const postInstall = new Date(manifestEditedAt + 1_000);
		utimesSync(lockfile, postInstall, postInstall);
		const afterRegen = checkLockfileDrift(manifest, { now: manifestEditedAt + 1_500 });
		expect(afterRegen.drifted).toBe(false);
		expect(afterRegen.reason).toBe("none");
	});
});

// ===========================================
// Package.json Consistency Check
// ===========================================

describe("checkPackageJsonConsistency", () => {
	it("returns no issues for clean package.json", () => {
		const pkg = JSON.stringify({
			dependencies: { express: "^4.18.0", lodash: "~4.17.21" },
			devDependencies: { vitest: "^3.0.0" },
		});
		expect(checkPackageJsonConsistency(pkg)).toEqual([]);
	});

	it("detects duplicate packages across deps and devDeps", () => {
		const pkg = JSON.stringify({
			dependencies: { lodash: "^4.17.21" },
			devDependencies: { lodash: "^4.17.20", vitest: "^3.0.0" },
		});
		const issues = checkPackageJsonConsistency(pkg);
		expect(issues.length).toBe(1);
		expect(issues[0].kind).toBe("duplicate");
		expect(issues[0].pkg).toBe("lodash");
		expect(issues[0].detail).toContain("both dependencies");
	});

	it("detects multiple duplicates", () => {
		const pkg = JSON.stringify({
			dependencies: { lodash: "^4.17.21", react: "^18.0.0" },
			devDependencies: { lodash: "^4.17.20", react: "^17.0.0" },
		});
		const issues = checkPackageJsonConsistency(pkg);
		const dupes = issues.filter((i) => i.kind === "duplicate");
		expect(dupes.length).toBe(2);
	});

	it("detects invalid semver specifiers", () => {
		const pkg = JSON.stringify({
			dependencies: {
				express: "not-a-version",
				lodash: "^4.17.21",
			},
		});
		const issues = checkPackageJsonConsistency(pkg);
		expect(issues.length).toBe(1);
		expect(issues[0].kind).toBe("invalid_semver");
		expect(issues[0].pkg).toBe("express");
	});

	it("accepts common valid version specifiers", () => {
		const pkg = JSON.stringify({
			dependencies: {
				a: "^1.2.3",
				b: "~2.0.0",
				c: ">=3.0.0",
				d: "1.2.3",
				e: "*",
				f: "latest",
				g: "1.0.0-beta.1",
				h: "1.0.0-alpha.1+build.123",
			},
		});
		expect(checkPackageJsonConsistency(pkg)).toEqual([]);
	});

	it("accepts workspace protocol versions", () => {
		const pkg = JSON.stringify({
			dependencies: {
				a: "workspace:*",
				b: "workspace:^",
				c: "workspace:~",
			},
		});
		expect(checkPackageJsonConsistency(pkg)).toEqual([]);
	});

	it("accepts link: and file: protocols", () => {
		const pkg = JSON.stringify({
			dependencies: {
				a: "file:../my-lib",
				b: "link:./packages/foo",
			},
		});
		expect(checkPackageJsonConsistency(pkg)).toEqual([]);
	});

	it("accepts git and npm: protocols", () => {
		const pkg = JSON.stringify({
			dependencies: {
				a: "git+https://github.com/user/repo.git",
				b: "npm:actual-pkg@^1.0.0",
				c: "github:user/repo",
			},
		});
		expect(checkPackageJsonConsistency(pkg)).toEqual([]);
	});

	it("accepts version ranges with ||", () => {
		const pkg = JSON.stringify({
			dependencies: {
				a: "^1.0.0 || ^2.0.0",
			},
		});
		expect(checkPackageJsonConsistency(pkg)).toEqual([]);
	});

	it("checks peerDependencies and optionalDependencies too", () => {
		const pkg = JSON.stringify({
			peerDependencies: { react: "invalid!" },
			optionalDependencies: { fsevents: "also bad" },
		});
		const issues = checkPackageJsonConsistency(pkg);
		const badVer = issues.filter((i) => i.kind === "invalid_semver");
		expect(badVer.length).toBe(2);
		expect(badVer.map((i) => i.pkg).sort()).toEqual(["fsevents", "react"]);
	});

	it("returns empty for malformed JSON", () => {
		expect(checkPackageJsonConsistency("{not valid json")).toEqual([]);
	});

	it("returns empty when no dependency sections exist", () => {
		const pkg = JSON.stringify({ name: "my-pkg", version: "1.0.0" });
		expect(checkPackageJsonConsistency(pkg)).toEqual([]);
	});

	it("detects both duplicates and invalid semver together", () => {
		const pkg = JSON.stringify({
			dependencies: { lodash: "^4.17.21", bad: "nope" },
			devDependencies: { lodash: "^4.17.20" },
		});
		const issues = checkPackageJsonConsistency(pkg);
		expect(issues.length).toBe(2);
		expect(issues.map((i) => i.kind).sort()).toEqual(["duplicate", "invalid_semver"]);
	});
});
