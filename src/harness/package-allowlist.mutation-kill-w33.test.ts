import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	allowlistPath,
	hashLockfile,
	isPackageAllowed,
	loadAllowlist,
	matchSnapshot,
	saveAllowlist,
} from "./package-allowlist.js";
import type { PackageSpec } from "./package-install-parser.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "allowlist-mutkill-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function writeRaw(cwd: string, obj: unknown): void {
	const target = allowlistPath(cwd);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, JSON.stringify(obj));
}

describe("parseAllowlistEntry — mutant kills", () => {
	// test-contract: invariant — non-object rawEntry must drop the package (isJsonObject conditional)
	it("kills !isJsonObject(value)->false: a string package value is dropped", () => {
		writeRaw(workspace, {
			version: 1,
			packages: { npm: { badpkg: "not-an-object" } },
		});
		const al = loadAllowlist(workspace);
		expect(al.packages.npm.badpkg).toBeUndefined();
	});

	// test-contract: invariant — non-string approved_at must drop the entry
	it("kills typeof approved_at !== string ->false: numeric approved_at drops entry", () => {
		writeRaw(workspace, {
			version: 1,
			packages: { npm: { badpkg: { approved_at: 12345, approved_by: "qcody" } } },
		});
		const al = loadAllowlist(workspace);
		expect(al.packages.npm.badpkg).toBeUndefined();
	});

	// test-contract: invariant — non-string reason must be omitted from parsed entry
	it("kills typeof reason === string ->true: numeric reason is omitted", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {
				npm: { pkg: { approved_at: "a", approved_by: "b", reason: 42 } },
			},
		});
		const al = loadAllowlist(workspace);
		expect(nonNull(al.packages.npm.pkg)).toEqual({ approved_at: "a", approved_by: "b" });
	});

	// test-contract: invariant — non-string license must be omitted from parsed entry
	it("kills typeof license === string ->true: numeric license is omitted", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {
				npm: { pkg: { approved_at: "a", approved_by: "b", license: 7 } },
			},
		});
		const al = loadAllowlist(workspace);
		expect(nonNull(al.packages.npm.pkg)).toEqual({ approved_at: "a", approved_by: "b" });
	});
});

describe("parseLockfileSnapshot — mutant kills", () => {
	// test-contract: invariant — non-object raw snapshot must be dropped
	it("kills !isJsonObject(value)->false: string snapshot value is dropped", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {},
			lockfile_snapshots: { "package-lock.json": "not-an-object" },
		});
		const al = loadAllowlist(workspace);
		expect(al.lockfile_snapshots["package-lock.json"]).toBeUndefined();
	});

	// test-contract: invariant — non-string approved_at must drop the snapshot
	it("kills typeof approved_at !== string ->false: numeric approved_at drops snapshot", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {},
			lockfile_snapshots: {
				"package-lock.json": { sha256: "abc", approved_at: 1, approved_by: "b" },
			},
		});
		const al = loadAllowlist(workspace);
		expect(al.lockfile_snapshots["package-lock.json"]).toBeUndefined();
	});

	// test-contract: invariant — non-string approved_by must drop the snapshot
	it("kills typeof approved_by !== string ->false: numeric approved_by drops snapshot", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {},
			lockfile_snapshots: {
				"package-lock.json": { sha256: "abc", approved_at: "a", approved_by: 2 },
			},
		});
		const al = loadAllowlist(workspace);
		expect(al.lockfile_snapshots["package-lock.json"]).toBeUndefined();
	});

	// test-contract: invariant — non-string reason must be omitted from the parsed snapshot
	it("kills typeof reason === string ->true: numeric reason is omitted from snapshot", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {},
			lockfile_snapshots: {
				"package-lock.json": { sha256: "abc", approved_at: "a", approved_by: "b", reason: 9 },
			},
		});
		const al = loadAllowlist(workspace);
		expect(al.lockfile_snapshots["package-lock.json"]).toEqual({
			sha256: "abc",
			approved_at: "a",
			approved_by: "b",
		});
	});
});

describe("loadAllowlist — mutant kills", () => {
	// test-contract: invariant — file must be read as utf-8 text, not binary/garbage
	it("kills \"utf-8\"->\"\": reads valid JSON content with real UTF-8 text intact", () => {
		writeRaw(workspace, {
			version: 1,
			packages: { npm: { café: { approved_at: "a", approved_by: "b" } } },
		});
		const al = loadAllowlist(workspace);
		expect(al.packages.npm["café"]).toEqual({ approved_at: "a", approved_by: "b" });
	});

	// test-contract: invariant — a missing file must short-circuit to the empty allowlist
	it("kills !existsSync(p)->false: missing file returns default empty allowlist, not a read attempt", () => {
		const al = loadAllowlist(workspace);
		expect(al).toEqual({
			version: 1,
			packages: {
				npm: {},
				pypi: {},
				cargo: {},
				rubygems: {},
				go: {},
				composer: {},
				maven: {},
				gradle: {},
				nuget: {},
			},
			lockfile_snapshots: {},
		});
	});

	// test-contract: invariant — a top-level non-object parse result must fall back to base
	it("kills !isJsonObject(parsed)->false: a JSON array top-level falls back to empty base", () => {
		writeRaw(workspace, [1, 2, 3]);
		const al = loadAllowlist(workspace);
		expect(al.packages.npm).toEqual({});
		expect(al.lockfile_snapshots).toEqual({});
	});

	// test-contract: invariant — a non-object packages field must be skipped, not iterated
	it("kills isJsonObject(parsed.packages)->true: string packages field is skipped, leaving defaults", () => {
		writeRaw(workspace, { version: 1, packages: "oops" });
		const al = loadAllowlist(workspace);
		expect(al.packages.npm).toEqual({});
		expect(al.packages.pypi).toEqual({});
	});

	// test-contract: invariant — every() must require ALL ids to be strings, not just one (some())
	it("kills every->some on license_allowlist: a mixed array with one non-string is rejected entirely", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {},
			license_allowlist: ["MIT", 42],
		});
		const al = loadAllowlist(workspace);
		expect(al.license_allowlist).toBeUndefined();
	});

	// test-contract: invariant — a non-array license_allowlist must not be accepted
	it("kills Array.isArray(...) && every(...) ->true: object license_allowlist is rejected", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {},
			license_allowlist: { MIT: true },
		});
		const al = loadAllowlist(workspace);
		expect(al.license_allowlist).toBeUndefined();
	});

	// test-contract: invariant — the anonymous type-guard callback must check typeof id === "string" per element
	it("kills anonymous id-guard typeof id === string ->true: numeric id in license_allowlist rejects the whole list", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {},
			license_allowlist: [1, 2, 3],
		});
		const al = loadAllowlist(workspace);
		expect(al.license_allowlist).toBeUndefined();
	});

	// test-contract: invariant — a valid all-string license_allowlist must be kept as-is
	it("positive: a valid all-string license_allowlist is preserved", () => {
		writeRaw(workspace, {
			version: 1,
			packages: {},
			license_allowlist: ["MIT", "Apache-2.0"],
		});
		const al = loadAllowlist(workspace);
		expect(al.license_allowlist).toEqual(["MIT", "Apache-2.0"]);
	});
});

describe("saveAllowlist — mutant kills", () => {
	// test-contract: invariant — saved file must be written/readable as utf-8 text
	it("kills \"utf-8\"->\"\": round-trips content with non-ASCII text intact", () => {
		const al = loadAllowlist(workspace);
		al.packages.npm["日本語"] = { approved_at: "a", approved_by: "b" };
		saveAllowlist(workspace, al);
		const reloaded = loadAllowlist(workspace);
		expect(reloaded.packages.npm["日本語"]).toEqual({ approved_at: "a", approved_by: "b" });
	});
});

describe("isPackageAllowed — mutant kills", () => {
	// test-contract: invariant — the version-in-message fallback for an unspecified version must read "<unspecified>"
	it("kills \"<unspecified>\"->\"\": denial reason for a pinned entry with undefined version says <unspecified>", () => {
		const al = loadAllowlist(workspace);
		al.packages.npm.lodash = {
			approved_at: "a",
			approved_by: "b",
			version_range: "1.0.0",
		};
		const spec: PackageSpec = { kind: "registry", name: "lodash", version: undefined };
		const decision = isPackageAllowed(al, "npm", spec);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("requested at <unspecified>");
	});

	// test-contract: invariant — nullish-coalescing must use spec.version when it is a defined, non-empty string
	// (LogicalOperator mutant swaps ?? for && which would collapse a truthy version to the literal fallback)
	it("kills ?? -> && on spec.version fallback: a real version string appears verbatim in the reason", () => {
		const al = loadAllowlist(workspace);
		al.packages.npm.lodash = {
			approved_at: "a",
			approved_by: "b",
			version_range: "1.0.0",
		};
		const spec: PackageSpec = { kind: "registry", name: "lodash", version: "2.0.0" };
		const decision = isPackageAllowed(al, "npm", spec);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("requested at 2.0.0");
		expect(decision.reason).not.toContain("<unspecified>");
	});
});

describe("matchesVersionRange (via isPackageAllowed) — mutant kills", () => {
	function allow(version: string | undefined, range: string) {
		const al = loadAllowlist(workspace);
		al.packages.npm.pkg = { approved_at: "a", approved_by: "b", version_range: range };
		const spec: PackageSpec = { kind: "registry", name: "pkg", version };
		return isPackageAllowed(al, "npm", spec);
	}

	// test-contract: invariant — a version differing only by surrounding whitespace must still match (trim())
	it("kills specVersion.trim()->specVersion: whitespace-padded version still matches exact range", () => {
		const decision = allow("  1.2.3  ", "1.2.3");
		expect(decision.allowed).toBe(true);
	});

	// test-contract: invariant — a range differing only by surrounding whitespace must still match (trim())
	it("kills range.trim()->range: whitespace-padded range still matches exact version", () => {
		const decision = allow("1.2.3", "  1.2.3  ");
		expect(decision.allowed).toBe(true);
	});

	// test-contract: invariant — a genuinely differing version and range must NOT match, and the fail-closed
	// detail text must survive into the reason (kills the failure ObjectLiteral/StringLiteral mutants)
	it("kills fail-closed detail mutants: mismatched version and range are denied with the version_range hint", () => {
		const decision = allow("9.9.9", "1.2.3");
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("Update the allowlist entry's version_range");
	});

	// test-contract: invariant — stripPrefix must remove a leading caret so "^1.2.3" matches spec "1.2.3"
	it("kills stripPrefix(trimmed)===stripPrefix(cleanRange)->false via prefix-stripped equality", () => {
		const decision = allow("1.2.3", "^1.2.3");
		expect(decision.allowed).toBe(true);
	});

	// test-contract: invariant — stripPrefix's regex must be anchored (^) so it strips only a LEADING run,
	// never a matching char elsewhere in the string
	it("kills stripPrefix regex anchor removal: a mid-string 'v' must not be stripped, so ranges stay distinct", () => {
		const decision = allow("1.2.3", "1.v2.3");
		expect(decision.allowed).toBe(false);
	});

	// test-contract: invariant — stripPrefix's regex must use + (strip the WHOLE leading run), not just one char
	it("kills stripPrefix regex quantifier removal: a double-symbol prefix (^~) is fully stripped, not just one char", () => {
		const decision = allow("1.2.3", "^~1.2.3");
		expect(decision.allowed).toBe(true);
	});

	// test-contract: invariant — caret-range major-version match must require a non-empty major AND real equality
	// (kills both the ConditionalExpression and StringLiteral "" mutants on rMajor !== "")
	it("kills rMajor!==\"\" forced-true mutants: an empty-major caret range never matches a differing spec", () => {
		const decision = allow(".9.9", "^.1.2");
		expect(decision.allowed).toBe(false);
	});

	// test-contract: invariant — caret-range major-version match on real digits still succeeds
	it("positive: caret range matches when the major version agrees", () => {
		const decision = allow("1.9.0", "^1.0.0");
		expect(decision.allowed).toBe(true);
	});

	// test-contract: invariant — caret-range must reject a different major version
	it("kills startsWith mutants on caret major split: caret range rejects a different major version", () => {
		const decision = allow("2.0.0", "^1.0.0");
		expect(decision.allowed).toBe(false);
	});

	// test-contract: invariant — the major split must use "." as separator, not "" (char-split), so a
	// multi-digit major is compared whole rather than by its first character
	it("kills \".\" -> \"\" on the caret major split: a two-digit major matches only when fully equal", () => {
		const decision = allow("12.5.0", "^12.0.0");
		expect(decision.allowed).toBe(true);
	});

	// test-contract: invariant — cleanRange.startsWith("~") must gate the tilde branch — an unprefixed range
	// with no matching prefix must never fall into tilde parsing (kills the ConditionalExpression->true
	// and the "~"->"" StringLiteral mutants, both of which make startsWith always true)
	it("kills startsWith(\"~\") forced-true mutants: an unprefixed differing range is denied, not tilde-matched", () => {
		const decision = allow("1.2.3", "1.2.9");
		expect(decision.allowed).toBe(false);
	});

	// test-contract: invariant — tilde-range match must require the REAL major to agree, not be forced true
	it("kills rParts[0]===sParts[0]->true (tilde range): differing major with matching minor is rejected", () => {
		const decision = allow("2.5.0", "~1.5.0");
		expect(decision.allowed).toBe(false);
	});

	// test-contract: invariant — tilde-range match must require BOTH major AND minor equal
	it("kills the tilde AND-condition mutants: same major, different minor is rejected", () => {
		const decision = allow("1.5.0", "~1.2.0");
		expect(decision.allowed).toBe(false);
	});

	// test-contract: invariant — tilde-range positive case: same major.minor, different patch matches
	it("positive: tilde range matches when major and minor both agree", () => {
		const decision = allow("1.2.9", "~1.2.0");
		expect(decision.allowed).toBe(true);
	});
});

// The following four mutants mutate the UNUSED `detail: ""` field on the three
// success (`ok: true`) return paths (exact / prefix-stripped / caret / tilde
// match) inside matchesVersionRange. isPackageAllowed only reads `.detail`
// when `!verdict.ok`, so an allowed decision never surfaces this field —
// these look unobservable through the exported surface. Left still_open
// (no equivalence verdict issued) rather than force a test through a private
// function: 95aa0ea0b348548a, 9472cb77b2bcee30, f05d713bb8db31ba,
// e89249a16517c798. Likewise 780f79b4cbab3a00 (trimmed===cleanRange->false)
// falls through to the stripPrefix-equality branch which returns the same
// ok:true for any input that would have matched exactly, so it produces no
// observable difference either — also left still_open.

describe("hashLockfile — mutant kills", () => {
	// test-contract: invariant — a missing file must short-circuit to null, never attempt to read
	it("kills !existsSync(path)->false: a nonexistent path returns null", () => {
		expect(hashLockfile(join(workspace, "does-not-exist.lock"))).toBeNull();
	});

	// test-contract: invariant — an existing file must hash successfully to a non-null sha256 hex string
	it("positive: an existing file returns a deterministic sha256 hex digest", () => {
		const p = join(workspace, "lock.txt");
		writeFileSync(p, "hello");
		const hash = hashLockfile(p);
		expect(hash).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		);
	});
});

describe("matchSnapshot — mutant kills", () => {
	// test-contract: invariant — a missing snapshot entry must short-circuit to false, never call hashLockfile
	it("kills !snap mutants: absent snapshot entry returns false without reading the lockfile", () => {
		const al = loadAllowlist(workspace);
		const result = matchSnapshot(al, "package-lock.json", join(workspace, "does-not-exist.lock"));
		expect(result).toBe(false);
	});

	// test-contract: invariant — a matching hash must return true
	it("positive: a snapshot whose recorded sha256 matches the file's hash returns true", () => {
		const al = loadAllowlist(workspace);
		const lockPath = join(workspace, "package-lock.json");
		writeFileSync(lockPath, "hello");
		al.lockfile_snapshots["package-lock.json"] = {
			sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			approved_at: "a",
			approved_by: "b",
		};
		expect(matchSnapshot(al, "package-lock.json", lockPath)).toBe(true);
	});
});

// hashLockfile only ever returns null or a non-empty 64-char hex digest, so
// `!actual` (mutant 80afb7b6522e8f36, mutated to the literal `false`) is
// unobservable through matchSnapshot: when actual is null the subsequent
// `actual === snap.sha256` comparison is false anyway (null never equals a
// recorded hex string), and when actual is a hex string `!actual` was already
// false. Suspect equivalent; left still_open (no equivalence verdict issued).
