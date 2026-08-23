import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks for every dependency of src/commands/verify/structure.ts. Each test
// configures return values, then calls the real exported functions and
// inspects either the mocked formatStructureVerifyOutput call args, the
// mocked evaluateStructureRules call args, process.exitCode, or captured
// process.stderr writes.
// ---------------------------------------------------------------------------

vi.mock("../../harness/structure/adoption.js", () => ({
	calculateAdoption: vi.fn(),
}));

vi.mock("../../harness/structure/artifact-graph.js", () => {
	const nodesJsonHolder = { value: { nodes: [] as Array<{ file: string | null }> } };
	class MockArtifactGraph {
		addNode() {}
		addEdge() {}
		toNodesJson() {
			return nodesJsonHolder.value;
		}
	}
	// Expose the holder on the class so tests can set nodes.
	(MockArtifactGraph as unknown as { __nodesJsonHolder: typeof nodesJsonHolder }).__nodesJsonHolder =
		nodesJsonHolder;
	return { ArtifactGraph: MockArtifactGraph };
});

vi.mock("../../harness/structure/baseline.js", () => ({
	isBaselined: vi.fn(() => false),
}));

vi.mock("../../harness/structure/cache-manager.js", () => ({
	computeManifestHash: vi.fn(() => "hash"),
	isCacheStale: vi.fn(() => false),
	readBaseline: vi.fn(() => ({})),
}));

vi.mock("../../harness/structure/extractors/index.js", () => ({
	runAllExtractors: vi.fn(() => ({ nodes: [], edges: [] })),
}));

vi.mock("../../harness/structure/rules/index.js", () => ({
	evaluateStructureRules: vi.fn(() => []),
}));

vi.mock("../../harness/structure/structure-checks.js", () => ({
	layerDeclaredArtifacts: vi.fn(),
}));

vi.mock("../../harness/structure/structure-formatter.js", () => ({
	formatStructureVerifyOutput: vi.fn(() => ({
		mode: "declared",
		findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 0 },
		details: [],
		adoption: {},
	})),
}));

vi.mock("../../harness/structure/structure-loader.js", () => ({
	getImplicitConfig: vi.fn(() => ({})),
	loadStructureConfig: vi.fn(),
}));

import { ArtifactGraph } from "../../harness/structure/artifact-graph.js";
import { isCacheStale } from "../../harness/structure/cache-manager.js";
import { runAllExtractors } from "../../harness/structure/extractors/index.js";
import { evaluateStructureRules } from "../../harness/structure/rules/index.js";
import { formatStructureVerifyOutput } from "../../harness/structure/structure-formatter.js";
import { loadStructureConfig } from "../../harness/structure/structure-loader.js";
import { calculateAdoption } from "../../harness/structure/adoption.js";
import { buildStructureJsonSection, runStructureVerify } from "./structure.js";

const nodesJsonHolder = (
	ArtifactGraph as unknown as { __nodesJsonHolder: { value: { nodes: Array<{ file: string | null }> } } }
).__nodesJsonHolder;

function baseConfig(overrides: Record<string, unknown> = {}) {
	return {
		mode: "declared",
		verify: {
			fail_on_invalid_structure: false,
			fail_on_deterministic: false,
		},
		adoption: {
			coverage_thresholds: {},
		},
		...overrides,
	};
}

function setLoadStructureConfig(opts: {
	config?: Record<string, unknown> | null;
	errors?: string[];
	implicit?: boolean;
}) {
	(loadStructureConfig as ReturnType<typeof vi.fn>).mockReturnValue({
		config: opts.config ?? baseConfig(),
		errors: opts.errors ?? [],
		implicit: opts.implicit ?? false,
	});
}

describe("buildStructureJsonSection / runStructureVerify — mutation kill (w62)", () => {
	let stderrWrites: string[];
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		process.exitCode = undefined;
		nodesJsonHolder.value = { nodes: [] };
		stderrWrites = [];
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrWrites.push(String(chunk));
			return true;
		});
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		(evaluateStructureRules as ReturnType<typeof vi.fn>).mockReset().mockReturnValue([]);
		(formatStructureVerifyOutput as ReturnType<typeof vi.fn>).mockReset().mockReturnValue({
			mode: "declared",
			findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 0 },
			details: [],
			adoption: {},
		});
		(calculateAdoption as ReturnType<typeof vi.fn>).mockReset().mockReturnValue({});
		(isCacheStale as ReturnType<typeof vi.fn>).mockReset().mockReturnValue(false);
		(runAllExtractors as ReturnType<typeof vi.fn>).mockReset().mockReturnValue({ nodes: [], edges: [] });
		setLoadStructureConfig({});
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		stdoutSpy.mockRestore();
		process.exitCode = undefined;
	});

	// -- kills 591d56af80dcd164, 1eaba6433b2bcb23, 58089bd57f69d361 --------
	it("invalidFiles stays empty when config is implicit, even with load errors", () => {
		setLoadStructureConfig({ config: baseConfig(), errors: ["boom"], implicit: true });

		buildStructureJsonSection("/fake/cwd", {});

		const calls = (formatStructureVerifyOutput as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBe(1);
		const call = calls[0]![0];
		expect(call.invalidFiles).toEqual([]);
	});

	// -- kills 29bf141d049efbb3, 30e669df90a04a24, a9d426628e30bade -------
	it("allFiles is the deduped, filtered, mapped set of node.file values", () => {
		nodesJsonHolder.value = {
			nodes: [{ file: "a.ts" }, { file: null }, { file: "b.ts" }, { file: "a.ts" }],
		};

		buildStructureJsonSection("/fake/cwd", {});

		const calls = (evaluateStructureRules as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBe(1);
		const allFilesArg = calls[0]![2];
		expect(allFilesArg).toEqual(["a.ts", "b.ts"]);
	});

	// -- kills a272c65a01ad0339, 0c593fa34fbd8db9 --------------------------
	it("passes the full structured object (not {}) to the formatter, with catalogFresh derived from isCacheStale", () => {
		(isCacheStale as ReturnType<typeof vi.fn>).mockReturnValue(true);
		const config = baseConfig();
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(evaluateStructureRules as ReturnType<typeof vi.fn>).mockReturnValue([]);

		buildStructureJsonSection("/fake/cwd", {});

		const calls2 = (formatStructureVerifyOutput as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls2.length).toBe(1);
		const call = calls2[0]![0];
		expect(call).toHaveProperty("config");
		expect(call).toHaveProperty("findings");
		expect(call).toHaveProperty("invalidFiles");
		expect(call).toHaveProperty("adoption");
		expect(call.catalogFresh).toBe(false);
	});

	// -- kills 17155f71494538ac ---------------------------------------------
	it("buildStructureJsonSection does not apply the adoption gate when opts.adoptionGate is false", () => {
		const config = baseConfig({
			adoption: { coverage_thresholds: { docs: 0.9 } },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(calculateAdoption as ReturnType<typeof vi.fn>).mockReturnValue({ docs: 0.1 });

		buildStructureJsonSection("/fake/cwd", { adoptionGate: false });

		expect(process.exitCode).toBeUndefined();
	});

	// -- kills a3f48f1d5eb705e (buildStructureJsonSection context) --------
	it("buildStructureJsonSection only counts fully_deterministic findings toward the exit code", () => {
		const config = baseConfig({
			verify: { fail_on_invalid_structure: false, fail_on_deterministic: true },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(evaluateStructureRules as ReturnType<typeof vi.fn>).mockReturnValue([{ determinism: "heuristic" }]);

		buildStructureJsonSection("/fake/cwd", {});

		expect(process.exitCode).toBeUndefined();
	});

	// -- kills baff382878f68ba2, 4e5347edd62aa14b, 7203a7415aea5f06/3bea2719c060ae2b --
	it("text report omits the blank separator line when there are no details", () => {
		(formatStructureVerifyOutput as ReturnType<typeof vi.fn>).mockReturnValue({
			mode: "declared",
			findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 0 },
			details: [],
			adoption: { cat: 0.5 },
		});

		return runStructureVerify("/fake/cwd", { json: false }).then(() => {
			const full = stderrWrites.join("");
			const expected =
				"\n  \x1b[1minterlinked verify --structure\x1b[0m\n" +
				"  mode: declared\n" +
				"  findings: 0 deterministic, 0 partial, 0 heuristic\n" +
				"\n  \x1b[1madoption:\x1b[0m\n" +
				"    cat: \x1b[33m50%\x1b[0m\n" +
				"\n";
			expect(full).toBe(expected);
		});
	});

	it("text report includes the blank separator line and each detail when details is non-empty", () => {
		(formatStructureVerifyOutput as ReturnType<typeof vi.fn>).mockReturnValue({
			mode: "declared",
			findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 0 },
			details: [
				{
					name: "x",
					file: "f.ts",
					artifact_id: "a1",
					determinism: "heuristic",
					required_updates: [],
				},
			],
			adoption: { cat: 0.5 },
		});

		return runStructureVerify("/fake/cwd", { json: false }).then(() => {
			const full = stderrWrites.join("");
			const expected =
				"\n  \x1b[1minterlinked verify --structure\x1b[0m\n" +
				"  mode: declared\n" +
				"  findings: 0 deterministic, 0 partial, 0 heuristic\n" +
				"\n" +
				"  \x1b[33mx\x1b[0m f.ts\n" +
				"    artifact: a1 (heuristic)\n" +
				"\n  \x1b[1madoption:\x1b[0m\n" +
				"    cat: \x1b[33m50%\x1b[0m\n" +
				"\n";
			expect(full).toBe(expected);
		});
	});

	// -- kills f581ae5513eb705e ---------------------------------------------
	it("runStructureVerify does not apply the adoption gate when opts.adoptionGate is false", () => {
		const config = baseConfig({
			adoption: { coverage_thresholds: { docs: 0.9 } },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(calculateAdoption as ReturnType<typeof vi.fn>).mockReturnValue({ docs: 0.1 });

		return runStructureVerify("/fake/cwd", { json: true, adoptionGate: false }).then(() => {
			expect(process.exitCode).toBeUndefined();
		});
	});

	// -- kills 802ea0d326e7aaf0 -----------------------------------------------
	it("adoption gate failure message ends with a newline", () => {
		const config = baseConfig({
			adoption: { coverage_thresholds: { docs: 0.9 } },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(calculateAdoption as ReturnType<typeof vi.fn>).mockReturnValue({ docs: 0.1 });

		return runStructureVerify("/fake/cwd", { json: false, adoptionGate: true }).then(() => {
			const failLine = stderrWrites.find((s) => s.includes("adoption gate failed"));
			expect(failLine).toBeDefined();
			expect(failLine?.endsWith("\n")).toBe(true);
		});
	});

	// -- kills 5ca9afe5655abd87, 0ebab4deb746ac13, b9fa7d41bf1744ba (runStructureVerify context) --
	it("runStructureVerify only counts fully_deterministic findings toward the exit code", () => {
		const config = baseConfig({
			verify: { fail_on_invalid_structure: false, fail_on_deterministic: true },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(evaluateStructureRules as ReturnType<typeof vi.fn>).mockReturnValue([{ determinism: "heuristic" }]);
		(formatStructureVerifyOutput as ReturnType<typeof vi.fn>).mockReturnValue({
			mode: "declared",
			findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 1 },
			details: [],
			adoption: {},
		});

		return runStructureVerify("/fake/cwd", { json: true }).then(() => {
			expect(process.exitCode).toBeUndefined();
		});
	});
});
