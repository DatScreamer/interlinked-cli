// ===========================================
// file-checks-endpoint-laziness — wave-37 survivor-kill suite
// ===========================================
// Targets StringLiteral mutants on the per-bucket check-id string literal
// argument passed to `toIssues(check, relPath, matches)` inside
// `runEndpointAndLazinessChecks`. Each mutant blanks/alters one check-id
// literal; a mutant survives silently whenever the corresponding detector
// never fires for any tested content (the array stays empty either way).
// Every case below crafts content that makes ITS detector actually push a
// non-empty match array, then asserts the resulting issue's `.check` field
// equals the exact literal — killing the mutant on that literal specifically.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { runEndpointAndLazinessChecks } from "./file-checks-endpoint-laziness.js";
import { type FileCheckContext } from "./file-checks-shared.js";
import { emptyResults } from "./tool-results-types.js";

function ctx(content: string, file = "/tmp/sample.ts"): FileCheckContext {
	return { file, content, relPath: file.replace(/^\/tmp\//, ""), cwd: "/tmp", r: emptyResults(), piiOpts: {} };
}

describe("runEndpointAndLazinessChecks — check-id literal survivors (wave 37)", () => {
	// test-contract: public-api — endpoint_idor_shape check-id string
	it("idor_shape fires with check id endpoint_idor_shape", () => {
		const tmp = mkdtempSync(join(tmpdir(), "interlinked-w37-"));
		try {
			const file = join(tmp, "users.ts");
			const content = [
				'import express from "express";',
				"const app = express();",
				'app.get("/users/:id", async (req, res) => {',
				"  const user = await prisma.user.findUnique({ where: { id: req.params.id } });",
				"  res.json(user);",
				"});",
			].join("\n");
			writeFileSync(file, content);
			const c = ctx(content, file);
			runEndpointAndLazinessChecks(c);
			expect(c.r.endpointIdorShape.length).toBeGreaterThan(0);
			expect(nonNull(c.r.endpointIdorShape[0]).check).toBe("endpoint_idor_shape");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// test-contract: public-api — endpoint_auth_missing check-id string
	it("auth_missing fires with check id endpoint_auth_missing", () => {
		const tmp = mkdtempSync(join(tmpdir(), "interlinked-w37-"));
		try {
			const file = join(tmp, "routes.ts");
			const content = [
				'import express from "express";',
				"const app = express();",
				'app.get("/admin/users", (req, res) => {',
				"  res.json({ ok: true });",
				"});",
			].join("\n");
			writeFileSync(file, content);
			const c = ctx(content, file);
			runEndpointAndLazinessChecks(c);
			expect(c.r.endpointAuthMissing.length).toBeGreaterThan(0);
			expect(nonNull(c.r.endpointAuthMissing[0]).check).toBe("endpoint_auth_missing");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// test-contract: public-api — endpoint_missing_tenant_filter check-id string
	it("missing_tenant_filter fires with check id endpoint_missing_tenant_filter", () => {
		const tmp = mkdtempSync(join(tmpdir(), "interlinked-w37-"));
		try {
			const file = join(tmp, "projects.ts");
			const content = [
				"app.get('/api/projects', async (req, res) => {",
				"  const projects = await prisma.project.findMany({ where: { status: 'active' } });",
				"  res.json(projects);",
				"});",
			].join("\n");
			writeFileSync(file, content);
			const c = ctx(content, file);
			runEndpointAndLazinessChecks(c);
			expect(c.r.endpointMissingTenantFilter.length).toBeGreaterThan(0);
			expect(nonNull(c.r.endpointMissingTenantFilter[0]).check).toBe(
				"endpoint_missing_tenant_filter",
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// test-contract: public-api — endpoint_ssrf_shape check-id string
	it("ssrf_shape fires with check id endpoint_ssrf_shape", () => {
		const tmp = mkdtempSync(join(tmpdir(), "interlinked-w37-"));
		try {
			const file = join(tmp, "proxy.ts");
			const content = [
				"app.post('/api/proxy', async (req, res) => {",
				"  const url = req.body.url;",
				"  const r = await fetch(url);",
				"  res.json(await r.json());",
				"});",
			].join("\n");
			writeFileSync(file, content);
			const c = ctx(content, file);
			runEndpointAndLazinessChecks(c);
			expect(c.r.endpointSsrfShape.length).toBeGreaterThan(0);
			expect(nonNull(c.r.endpointSsrfShape[0]).check).toBe("endpoint_ssrf_shape");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// test-contract: public-api — endpoint_mass_assignment check-id string
	it("mass_assignment fires with check id endpoint_mass_assignment", () => {
		const tmp = mkdtempSync(join(tmpdir(), "interlinked-w37-"));
		try {
			const file = join(tmp, "users.ts");
			const content = [
				"app.post('/api/users', async (req, res) => {",
				"  const user = await prisma.user.create({ data: req.body });",
				"  res.json(user);",
				"});",
			].join("\n");
			writeFileSync(file, content);
			const c = ctx(content, file);
			runEndpointAndLazinessChecks(c);
			expect(c.r.endpointMassAssignment.length).toBeGreaterThan(0);
			expect(nonNull(c.r.endpointMassAssignment[0]).check).toBe("endpoint_mass_assignment");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// test-contract: public-api — agent_thumbprint_prose check-id string
	it("agent-thumbprint prose fires with check id agent_thumbprint_prose", () => {
		const c = ctx(
			"function run() {\n" +
				"\t// in a real implementation this would call the API\n" +
				"\treturn null;\n" +
				"}\n",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.agentThumbprintProse.length).toBeGreaterThan(0);
		expect(nonNull(c.r.agentThumbprintProse[0]).check).toBe("agent_thumbprint_prose");
	});

	// test-contract: public-api — file_level_suppression check-id string
	it("file-level suppression fires with check id file_level_suppression", () => {
		const c = ctx("// @ts-nocheck\nexport const value = 1;\n");
		runEndpointAndLazinessChecks(c);
		expect(c.r.fileLevelSuppression.length).toBeGreaterThan(0);
		expect(nonNull(c.r.fileLevelSuppression[0]).check).toBe("file_level_suppression");
	});

	// test-contract: public-api — double_cast_unknown check-id string
	it("double-cast fires with check id double_cast_unknown", () => {
		const c = ctx("const value = data as unknown as Widget;\n");
		runEndpointAndLazinessChecks(c);
		expect(c.r.doubleCastUnknown.length).toBeGreaterThan(0);
		expect(nonNull(c.r.doubleCastUnknown[0]).check).toBe("double_cast_unknown");
	});

	// test-contract: public-api — untestable_time_in_source check-id string
	it("untestable time in source fires with check id untestable_time_in_source", () => {
		const c = ctx("export function stamp() {\n\treturn Date.now();\n}\n");
		runEndpointAndLazinessChecks(c);
		expect(c.r.untestableTimeInSource.length).toBeGreaterThan(0);
		expect(nonNull(c.r.untestableTimeInSource[0]).check).toBe("untestable_time_in_source");
	});

	// test-contract: public-api — type_smuggling check-id string
	it("type smuggling fires with check id type_smuggling", () => {
		const c = ctx("const value = 42;\nconst asStr = value as string;\n");
		runEndpointAndLazinessChecks(c);
		expect(c.r.typeSmuggling.length).toBeGreaterThan(0);
		expect(nonNull(c.r.typeSmuggling[0]).check).toBe("type_smuggling");
	});

	// test-contract: public-api — union_widened_with_string check-id string
	it("union widened with string fires with check id union_widened_with_string", () => {
		const c = ctx('type Status = "on" | "off" | string;\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.unionWidenedWithString.length).toBeGreaterThan(0);
		expect(nonNull(c.r.unionWidenedWithString[0]).check).toBe("union_widened_with_string");
	});

	// test-contract: public-api — nodeenv_branch_in_prod check-id string
	it("NODE_ENV branch in prod fires with check id nodeenv_branch_in_prod", () => {
		const c = ctx('if (process.env.NODE_ENV === "test") { doThing(); }\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.nodeenvBranchInProd.length).toBeGreaterThan(0);
		expect(nonNull(c.r.nodeenvBranchInProd[0]).check).toBe("nodeenv_branch_in_prod");
	});

	// test-contract: public-api — unbounded_promise_all check-id string
	it("unbounded Promise.all fires with check id unbounded_promise_all", () => {
		const c = ctx("async function run(items) {\n\treturn Promise.all(items.map(load));\n}\n");
		runEndpointAndLazinessChecks(c);
		expect(c.r.unboundedPromiseAll.length).toBeGreaterThan(0);
		expect(nonNull(c.r.unboundedPromiseAll[0]).check).toBe("unbounded_promise_all");
	});

	// test-contract: public-api — fetch_without_timeout check-id string
	it("fetch without timeout fires with check id fetch_without_timeout", () => {
		const c = ctx('async function run() {\n\treturn fetch("https://example.com/data");\n}\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.fetchWithoutTimeout.length).toBeGreaterThan(0);
		expect(nonNull(c.r.fetchWithoutTimeout[0]).check).toBe("fetch_without_timeout");
	});

	// test-contract: public-api — sync_io_on_hot_path check-id string
	it("sync I/O on hot path fires with check id sync_io_on_hot_path", () => {
		const c = ctx(
			'import express from "express";\n' +
				"const app = express();\n" +
				"function handleRequest(req, res) {\n" +
				'\tconst data = readFileSync("/tmp/x");\n' +
				"\tres.send(data);\n" +
				"}\n",
			"/tmp/handlers/routes.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.syncIoOnHotPath.length).toBeGreaterThan(0);
		expect(nonNull(c.r.syncIoOnHotPath[0]).check).toBe("sync_io_on_hot_path");
	});

	// test-contract: public-api — duplicate_test_names check-id string
	it("duplicate test names fires with check id duplicate_test_names", () => {
		const c = ctx(
			'it("does the thing", () => {});\n' + 'it("does the thing", () => {});\n',
			"/tmp/sample.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.duplicateTestNames.length).toBeGreaterThan(0);
		expect(nonNull(c.r.duplicateTestNames[0]).check).toBe("duplicate_test_names");
	});

	// test-contract: public-api — real_io_in_tests check-id string
	it("real I/O in tests fires with check id real_io_in_tests", () => {
		const c = ctx('writeFileSync("/var/data/output.txt", "x");\n', "/tmp/sample.test.ts");
		runEndpointAndLazinessChecks(c);
		expect(c.r.realIoInTests.length).toBeGreaterThan(0);
		expect(nonNull(c.r.realIoInTests[0]).check).toBe("real_io_in_tests");
	});

	// test-contract: public-api — test_nondeterminism check-id string
	it("test nondeterminism fires with check id test_nondeterminism", () => {
		const c = ctx(
			'it("uses time", () => {\n\tconst t = Date.now();\n\texpect(t).toBeGreaterThan(0);\n});\n',
			"/tmp/sample.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.testNondeterminism.length).toBeGreaterThan(0);
		expect(nonNull(c.r.testNondeterminism[0]).check).toBe("test_nondeterminism");
	});

	// test-contract: public-api — hardcoded_timeout_in_tests check-id string
	it("hardcoded timeout in tests fires with check id hardcoded_timeout_in_tests", () => {
		const c = ctx('it("waits", async () => {\n\tawait new Promise(r => setTimeout(r, 500));\n});\n', "/tmp/sample.test.ts");
		runEndpointAndLazinessChecks(c);
		expect(c.r.hardcodedTimeoutInTests.length).toBeGreaterThan(0);
		expect(nonNull(c.r.hardcodedTimeoutInTests[0]).check).toBe("hardcoded_timeout_in_tests");
	});

	// test-contract: public-api — test_missing_sut_import check-id string
	it("test missing SUT import fires with check id test_missing_sut_import", () => {
		const c = ctx(
			'import { describe, it, expect } from "vitest";\n' +
				'it("does nothing", () => { expect(1).toBe(1); });\n',
			"/tmp/orphan.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.testMissingSutImport.length).toBeGreaterThan(0);
		expect(nonNull(c.r.testMissingSutImport[0]).check).toBe("test_missing_sut_import");
	});

	// test-contract: public-api — mocking_the_sut_self check-id string
	it("mocking the SUT self fires with check id mocking_the_sut_self", () => {
		const c = ctx('vi.mock("./widget");\n' + 'it("does nothing", () => {});\n', "/tmp/widget.test.ts");
		runEndpointAndLazinessChecks(c);
		expect(c.r.mockingTheSutSelf.length).toBeGreaterThan(0);
		expect(nonNull(c.r.mockingTheSutSelf[0]).check).toBe("mocking_the_sut_self");
	});

	// test-contract: public-api — test_subprocess_default_timeout check-id string
	it("test subprocess default timeout fires with check id test_subprocess_default_timeout", () => {
		const c = ctx(
			'import { execSync } from "child_process";\n' +
				'it("runs tsc", () => {\n\texecSync("npx tsc --noEmit");\n});\n',
			"/tmp/sample.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.testSubprocessDefaultTimeout.length).toBeGreaterThan(0);
		expect(nonNull(c.r.testSubprocessDefaultTimeout[0]).check).toBe(
			"test_subprocess_default_timeout",
		);
	});

	// test-contract: public-api — mock_only_test check-id string
	it("mock-only test fires with check id mock_only_test", () => {
		const c = ctx(
			'it("calls the callback", () => {\n\texpect(fn).toHaveBeenCalled();\n});\n',
			"/tmp/sample.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.mockOnlyTest.length).toBeGreaterThan(0);
		expect(nonNull(c.r.mockOnlyTest[0]).check).toBe("mock_only_test");
	});

	// test-contract: public-api — happy_path_only_test check-id string
	it("happy-path-only test fires with check id happy_path_only_test", () => {
		const c = ctx(
			'it("case one", () => { expect(1).toBe(1); });\n' +
				'it("case two", () => { expect(2).toBe(2); });\n' +
				'it("case three", () => { expect(3).toBe(3); });\n',
			"/tmp/sample.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.happyPathOnlyTest.length).toBeGreaterThan(0);
		expect(nonNull(c.r.happyPathOnlyTest[0]).check).toBe("happy_path_only_test");
	});

	// test-contract: public-api — introverted_test check-id string
	it("introverted test fires with check id introverted_test", () => {
		const c = ctx(
			'import { bar } from "./foo";\n' + 'it("does something", () => {\n\texpect(1).toBe(1);\n});\n',
			"/tmp/foo.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.introvertedTest.length).toBeGreaterThan(0);
		expect(nonNull(c.r.introvertedTest[0]).check).toBe("introverted_test");
	});

	// test-contract: public-api — procfs_probe_in_test check-id string
	it("procfs probe in test fires with check id procfs_probe_in_test", () => {
		const c = ctx(
			'const badPath = "/proc/nonexistent/x";\n' + 'it("does something", () => {});\n',
			"/tmp/sample.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.procfsProbeInTest.length).toBeGreaterThan(0);
		expect(nonNull(c.r.procfsProbeInTest[0]).check).toBe("procfs_probe_in_test");
	});

	// test-contract: public-api — empty_body_handler check-id string
	it("empty-body handler fires with check id empty_body_handler", () => {
		const c = ctx("function handleFoo() {\n}\n");
		runEndpointAndLazinessChecks(c);
		expect(c.r.emptyBodyHandler.length).toBeGreaterThan(0);
		expect(nonNull(c.r.emptyBodyHandler[0]).check).toBe("empty_body_handler");
	});

	// test-contract: public-api — listener_pairing check-id string
	it("listener pairing fires with check id listener_pairing", () => {
		const c = ctx('window.addEventListener("resize", handler);\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.listenerPairing.length).toBeGreaterThan(0);
		expect(nonNull(c.r.listenerPairing[0]).check).toBe("listener_pairing");
	});

	// test-contract: public-api — schema_type_drift check-id string
	it("schema/type drift fires with check id schema_type_drift", () => {
		const c = ctx(
			"const FooSchema = z.object({\n\tid: z.string(),\n\tname: z.string(),\n});\n" +
				"interface Foo {\n\tid: string;\n}\n",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.schemaTypeDrift.length).toBeGreaterThan(0);
		expect(nonNull(c.r.schemaTypeDrift[0]).check).toBe("schema_type_drift");
	});

	// test-contract: public-api — migration_parity check-id string
	it("migration parity fires with check id migration_parity", () => {
		const tmp = mkdtempSync(join(tmpdir(), "interlinked-w37-mig-"));
		try {
			const migrationsDir = join(tmp, "migrations");
			mkdirSync(migrationsDir, { recursive: true });
			const upFile = join(migrationsDir, "0001_init_up.sql");
			writeFileSync(upFile, "CREATE TABLE t (id int);\n");
			const content = "CREATE TABLE t (id int);\n";
			const c = ctx(content, upFile);
			runEndpointAndLazinessChecks(c);
			expect(c.r.migrationParity.length).toBeGreaterThan(0);
			expect(nonNull(c.r.migrationParity[0]).check).toBe("migration_parity");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// test-contract: public-api — demo_data_unmarked check-id string
	it("demo data unmarked fires with check id demo_data_unmarked", () => {
		const c = ctx('const mockUser = { id: 1, name: "a" };\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.demoDataUnmarked.length).toBeGreaterThan(0);
		expect(nonNull(c.r.demoDataUnmarked[0]).check).toBe("demo_data_unmarked");
	});

	// test-contract: public-api — silent_demo_fallback check-id string
	it("silent demo fallback fires with check id silent_demo_fallback", () => {
		const c = ctx(
			"async function load() {\n" +
				"\ttry {\n" +
				'\t\tconst res = await fetch("https://api.example.com/data");\n' +
				"\t\treturn res;\n" +
				"\t} catch {\n" +
				"\t\treturn { items: [] };\n" +
				"\t}\n" +
				"}\n",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.silentDemoFallback.length).toBeGreaterThan(0);
		expect(nonNull(c.r.silentDemoFallback[0]).check).toBe("silent_demo_fallback");
	});

	// test-contract: public-api — demo_runtime_missing_banner check-id string
	it("demo runtime missing banner fires with check id demo_runtime_missing_banner", () => {
		const c = ctx(
			'import { demoData } from "./demo-runtime";\n' +
				"export default function App() {\n\treturn null;\n}\n",
			"/tmp/src/App.tsx",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.demoRuntimeMissingBanner.length).toBeGreaterThan(0);
		expect(nonNull(c.r.demoRuntimeMissingBanner[0]).check).toBe("demo_runtime_missing_banner");
	});

	// test-contract: public-api — placeholder_data_in_ui check-id string
	it("placeholder data in UI fires with check id placeholder_data_in_ui", () => {
		const c = ctx("<div>lorem ipsum</div>\n", "/tmp/sample.tsx");
		runEndpointAndLazinessChecks(c);
		expect(c.r.placeholderDataInUi.length).toBeGreaterThan(0);
		expect(nonNull(c.r.placeholderDataInUi[0]).check).toBe("placeholder_data_in_ui");
	});
});
