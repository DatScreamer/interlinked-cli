import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkPhantomDependencies,
	checkSelfImport,
	findWorkspaceRootFor,
} from "./agent-safety-deps.js";

// Smoke-test coverage for the agent-safety dependency-hygiene check family.
// Deeper coverage lives in `src/harness/__tests__/generic-checks-extended-*.test.ts`
// and friends — this file satisfies the harness's per-source-file test rule
// and guards the shape of the exported check functions.

describe("agent-safety deps check surface — smoke", () => {
	it("checkSelfImport returns an array", () => {
		expect(Array.isArray(checkSelfImport("", "a.ts"))).toBe(true);
	});
});

describe("findWorkspaceRootFor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wsroot-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns the immediate package dir when no workspace marker exists", () => {
		const pkgDir = join(tmp, "solo");
		mkdirSync(pkgDir);
		writeFileSync(join(pkgDir, "package.json"), "{}");
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(pkgDir);
	});

	it("walks up to a parent with `workspaces` field", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		const pkgDir = join(tmp, "packages", "foo");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "foo" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(tmp);
	});

	it("walks up to a parent with `pnpm-workspace.yaml`", () => {
		writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
		const pkgDir = join(tmp, "packages", "bar");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "bar" }));
		expect(findWorkspaceRootFor(join(pkgDir, "package.json"))).toBe(tmp);
	});
});

describe("checkPhantomDependencies — workspace awareness", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "phantom-ws-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("does NOT flag a dep imported only by a sibling workspace package", () => {
		// Workspace root with `workspaces` field
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);

		// packages/foo declares the dep but doesn't import it anywhere in its own dir
		const fooDir = join(tmp, "packages", "foo");
		mkdirSync(fooDir, { recursive: true });
		writeFileSync(
			join(fooDir, "package.json"),
			JSON.stringify({ name: "foo", dependencies: { "@scoped/util": "1.0.0" } }),
		);
		writeFileSync(join(fooDir, "index.ts"), "export const x = 1;\n");

		// packages/bar imports the dep — that's the cross-workspace usage that
		// the single-dir grep (pre-fix) missed.
		const barDir = join(tmp, "packages", "bar");
		mkdirSync(barDir, { recursive: true });
		writeFileSync(
			join(barDir, "package.json"),
			JSON.stringify({ name: "bar" }),
		);
		writeFileSync(
			join(barDir, "consumer.ts"),
			'import { foo } from "@scoped/util";\nconsole.log(foo);\n',
		);

		const out = checkPhantomDependencies(join(fooDir, "package.json"));
		expect(out).toEqual([]);
	});

	it("flags a dep that's nowhere in the workspace", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		const fooDir = join(tmp, "packages", "foo");
		mkdirSync(fooDir, { recursive: true });
		writeFileSync(
			join(fooDir, "package.json"),
			JSON.stringify({
				name: "foo",
				dependencies: { "totally-unused-pkg": "1.0.0" },
			}),
		);
		writeFileSync(join(fooDir, "index.ts"), "export const x = 1;\n");

		const out = checkPhantomDependencies(join(fooDir, "package.json"));
		expect(out).toHaveLength(1);
		expect(out[0].text).toContain("totally-unused-pkg");
	});
});
