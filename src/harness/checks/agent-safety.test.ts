import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkAesEcbMode,
	checkAsyncPromiseExecutor,
	checkFloatingPromises,
	checkMisusedPromises,
	checkPhantomDependencies,
	checkRecursiveWalkerLstat,
	checkSelfImport,
	checkSilentPromiseSwallow,
	findWorkspaceRootFor,
} from "./agent-safety.js";

// Smoke-test coverage for the agent-safety check family. Each check has
// deeper coverage in `src/harness/__tests__/generic-checks-extended-*.test.ts`
// and friends — this file satisfies the harness's per-source-file test rule
// and guards the shape of the exported check functions.

describe("checkFloatingPromises — regression guards", () => {
	it("does not flag interface/type method signatures", () => {
		// Signatures look like calls but are declarations; must not fire.
		const src = [
			"async function stop() { return; }",
			"interface Handle {",
			"  stop(reason?: string): Promise<void>;",
			"}",
		].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		expect(out).toEqual([]);
	});

	it("does not flag arrow-function concise-body return values", () => {
		// `(d) => fn(d)` returns the promise; Promise.all handles it.
		const src = [
			"async function fn(d: number) { return d; }",
			"const rows = await Promise.all(",
			"  xs.map((d) =>",
			"    fn(d),",
			"  ),",
			");",
		].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		expect(out).toEqual([]);
	});

	it("still flags a truly floating async call at statement position", () => {
		const src = [
			"async function doIt() { return; }",
			"function caller() {",
			"  doIt();", // floating — no await, no return, no void
			"}",
		].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("agent-safety check surface — smoke", () => {
	it("checkAsyncPromiseExecutor returns an array", () => {
		expect(Array.isArray(checkAsyncPromiseExecutor("", "a.ts"))).toBe(true);
	});

	it("checkMisusedPromises returns an array", () => {
		expect(Array.isArray(checkMisusedPromises("", "a.ts"))).toBe(true);
	});

	it("checkSelfImport returns an array", () => {
		expect(Array.isArray(checkSelfImport("", "a.ts"))).toBe(true);
	});

	it("checkAesEcbMode flags AES.MODE_ECB in Python", () => {
		expect(checkAesEcbMode("c = AES.new(k, AES.MODE_ECB)", "a.py").length).toBeGreaterThan(0);
	});

	it("checkAesEcbMode does NOT fire on AES-GCM strings", () => {
		expect(checkAesEcbMode('createCipheriv("aes-256-gcm", k, iv)', "a.ts")).toEqual([]);
	});
});

describe("checkSilentPromiseSwallow", () => {
	it("flags .catch(() => {})", () => {
		const out = checkSilentPromiseSwallow(
			'fetch("/api").catch(() => {});\n',
			"src/x.ts",
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .catch with bound param and empty body", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch((e) => {});\n",
			"src/x.ts",
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .catch returning literal undefined / null / void 0", () => {
		const cases = [
			"foo().catch(() => undefined);\n",
			"foo().catch(_ => null);\n",
			"foo().catch(() => void 0);\n",
		];
		for (const src of cases) {
			expect(checkSilentPromiseSwallow(src, "src/x.ts").length).toBeGreaterThanOrEqual(1);
		}
	});

	it("flags .catch(function (e) {})", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(function (e) {});\n",
			"src/x.ts",
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag .catch with a real handler body", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch((e) => log(e));\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT flag .catch with explicit param-ack body", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch((e) => { void e; });\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT flag .catch(handlerIdent) — unknown intent", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(handleError);\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT flag when an inline comment marks intent", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(() => { /* fire and forget */ });\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT run on test files", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(() => {});\n",
			"src/x.test.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT run on non-JS/TS files", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(() => {});\n",
			"src/x.py",
		);
		expect(out).toEqual([]);
	});
});

describe("checkRecursiveWalkerLstat", () => {
	const recursiveWalkerStatSync = [
		'import { readdirSync, statSync } from "node:fs";',
		"function walk(dir) {",
		"  for (const e of readdirSync(dir)) {",
		"    const p = dir + '/' + e;",
		"    const st = statSync(p);",
		"    if (st.isDirectory()) walk(p);",
		"  }",
		"}",
	].join("\n");

	it("flags a self-recursive walker that uses statSync to gate dir-recursion", () => {
		const out = checkRecursiveWalkerLstat(recursiveWalkerStatSync, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag the same walker once it switches to lstatSync", () => {
		const safe = recursiveWalkerStatSync.replace(/statSync/g, "lstatSync");
		const out = checkRecursiveWalkerLstat(safe, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("flags a class-method walker that recurses via this.<name>(...)", () => {
		const src = [
			'import { readdirSync, statSync } from "node:fs";',
			"class Walker {",
			"  walk(dir) {",
			"    for (const e of readdirSync(dir)) {",
			"      const p = dir + '/' + e;",
			"      if (statSync(p).isDirectory()) this.walk(p);",
			"    }",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag a non-recursive function that uses readdirSync + statSync", () => {
		const src = [
			'import { readdirSync, statSync } from "node:fs";',
			"function listOne(dir) {",
			"  return readdirSync(dir).filter((e) => statSync(dir + '/' + e).isFile());",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag a recursive function that doesn't read directories", () => {
		const src = [
			"function recurse(n) {",
			"  if (n <= 0) return;",
			"  recurse(n - 1);",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/x.ts");
		expect(out).toEqual([]);
	});

	it("does NOT run on test files", () => {
		const out = checkRecursiveWalkerLstat(recursiveWalkerStatSync, "src/walker.test.ts");
		expect(out).toEqual([]);
	});

	it("does NOT run on non-JS/TS files", () => {
		const out = checkRecursiveWalkerLstat(recursiveWalkerStatSync, "src/walker.py");
		expect(out).toEqual([]);
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
