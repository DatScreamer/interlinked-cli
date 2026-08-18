// Mutation-kill tests for shared.ts's resolveInterlinkedCliPackageRoot — the
// private upward-walk resolver behind isPatternDataFile's harness-internal
// exemption. Isolated into its own file (rather than appended to
// shared.mutation-kill.test.ts) because it needs node:fs/node:url mocked to
// control the walk deterministically; shared.mutation-kill.test.ts and
// shared.test.ts both exercise isPatternDataFile against the REAL filesystem
// and would break under a file-wide fs mock.
//
// resolveInterlinkedCliPackageRoot is not exported, so every case below
// observes it only through the exported isPatternDataFile/isPatternDataFile
// surface, matching the module's own documented test seam
// (__setPackageRootForTesting exists precisely to let tests control the
// cache; the cases here instead exercise the WALK that populates that cache).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let existsImpl: (path: string) => boolean = () => false;
let readImpl: (path: string) => string = () => "{}";
let moduleDirImpl: () => string = () => "/unused/module.ts";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: (p: unknown) => existsImpl(String(p)),
		readFileSync: (p: unknown, _opts?: unknown) => readImpl(String(p)),
	};
});

vi.mock("node:url", async () => {
	const actual = await vi.importActual<typeof import("node:url")>("node:url");
	return {
		...actual,
		fileURLToPath: (_url?: unknown) => moduleDirImpl(),
	};
});

import { __setPackageRootForTesting, isPatternDataFile } from "./shared.js";

describe("resolveInterlinkedCliPackageRoot mutation boundaries (via isPatternDataFile)", () => {
	beforeEach(() => {
		__setPackageRootForTesting(undefined);
		existsImpl = () => false;
		readImpl = () => "{}";
		moduleDirImpl = () => "/unused/module.ts";
	});

	afterEach(() => {
		__setPackageRootForTesting(undefined);
	});

	// test-contract: security — the upward walk is bounded to eight ancestor checks; a package.json that only exists past that bound must never resolve the exemption's package root
	it("never resolves a package root that only exists past the eight-hop walk bound", () => {
		moduleDirImpl = () => "/f0/f1/f2/f3/f4/f5/f6/f7/f8/f9/module.ts";
		existsImpl = (p) => p === "/f0/f1/package.json";
		readImpl = () => JSON.stringify({ name: "interlinked-cli" });

		expect(isPatternDataFile("/f0/f1/harness/checks/foo.ts")).toBe(false);
	});

	// test-contract: invariant — a package.json is only ever read after existsSync reports it present; the exemption must not fire when existsSync says the file is absent
	it("never resolves a package root at a hop where existsSync reports the manifest absent", () => {
		moduleDirImpl = () => "/pkgtest/module.ts";
		existsImpl = () => false;
		readImpl = () => JSON.stringify({ name: "interlinked-cli" });

		expect(isPatternDataFile("/pkgtest/harness/checks/foo.ts")).toBe(false);
	});

	// test-contract: security — a well-formed, truthy package.json whose name is not literally "interlinked-cli" must never satisfy the harness-internal exemption
	it("rejects a well-formed package.json whose name does not match this package", () => {
		moduleDirImpl = () => "/pkgtest2/module.ts";
		existsImpl = (p) => p === "/pkgtest2/package.json";
		readImpl = () => JSON.stringify({ name: "not-interlinked-cli" });

		expect(isPatternDataFile("/pkgtest2/harness/checks/foo.ts")).toBe(false);
	});

	// test-contract: security — a package.json literally named "interlinked-cli" must resolve as this package's own root and enable the exemption
	it("accepts a package.json literally named interlinked-cli as the resolved root", () => {
		moduleDirImpl = () => "/pkgtest3/module.ts";
		existsImpl = (p) => p === "/pkgtest3/package.json";
		readImpl = () => JSON.stringify({ name: "interlinked-cli" });

		expect(isPatternDataFile("/pkgtest3/harness/checks/foo.ts")).toBe(true);
	});

	// test-contract: boundary — once the walk reaches filesystem root it must stop; it must not re-inspect root's package.json on a later hop
	it("stops at the first root check and never finds a root package.json that only appears on a later, redundant re-check", () => {
		moduleDirImpl = () => "/shallow/module.ts";
		let rootCheckCount = 0;
		existsImpl = (p) => {
			if (p === "/shallow/package.json") return false;
			if (p === "/package.json") {
				rootCheckCount++;
				return rootCheckCount >= 2;
			}
			return false;
		};
		readImpl = () => JSON.stringify({ name: "interlinked-cli" });

		expect(isPatternDataFile("//harness/checks/foo.ts")).toBe(false);
	});
});
