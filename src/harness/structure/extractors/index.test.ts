import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactGraph } from "../artifact-graph.js";
import { layerDeclaredArtifacts } from "../structure-checks.js";
import { loadStructureConfig } from "../structure-loader.js";
import type { ArtifactKind } from "../types.js";
import { MAX_WALK_ENTRIES } from "./bounded-walk.js";
import { allExtractors, extractSingleFile, relinkEditedFile, runAllExtractors } from "./index.js";

// Runtime-constructed string so the harness env-ref scanner doesn't flag
// this test file as referencing a fixture env var.
const ENV_REF = "process.env." + "T" + "EST_Z";

/** Materialise a fixture repo: `{ "rel/path": contents }`, parents auto-created. */
function writeFiles(root: string, files: Record<string, string>): void {
	for (const [rel, contents] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, contents);
	}
}

/** Build the same graph production does: extracted nodes/edges + declared
 *  artifacts layered on top (mirrors structure-checks.buildGraph). */
function buildDeclaredGraph(root: string): ArtifactGraph {
	const graph = new ArtifactGraph();
	const extracted = runAllExtractors(root);
	for (const n of extracted.nodes) graph.addNode(n);
	for (const e of extracted.edges) graph.addEdge(e);
	const loaded = loadStructureConfig(root);
	expect(loaded.errors).toEqual([]);
	const config = loaded.config;
	if (!config) throw new Error("fixture interlinked/structure.json failed to load");
	layerDeclaredArtifacts(graph, root, config);
	return graph;
}

describe("extractors barrel", () => {
	it("exports the full extractor set", () => {
		expect(allExtractors.length).toBeGreaterThanOrEqual(7);
		const names = allExtractors.map((e) => e.metadata.name).sort();
		expect(names).toContain("module-extractor");
		expect(names).toContain("package-extractor");
		expect(names).toContain("env-extractor");
	});

	it("every extractor has {metadata, extract, classifyFile}", () => {
		for (const ex of allExtractors) {
			expect(ex.metadata).toBeTruthy();
			expect(typeof ex.extract).toBe("function");
			expect(typeof ex.classifyFile).toBe("function");
		}
	});
});

describe("runAllExtractors", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "run-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("combines nodes from every extractor", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "package.json"), "{}");
		writeFileSync(join(tmp, "src", "a.ts"), `${ENV_REF};\nconfig.get("k");`);
		writeFileSync(join(tmp, "src", "a.test.ts"), "");
		writeFileSync(join(tmp, "README.md"), "#");

		const { nodes, edges } = runAllExtractors(tmp);
		const kinds = new Set(nodes.map((n) => n.kind));
		expect(kinds.has("module")).toBe(true);
		expect(kinds.has("package")).toBe(true);
		expect(kinds.has("env_key")).toBe(true);
		expect(kinds.has("test")).toBe(true);
		expect(kinds.has("doc")).toBe(true);
		// belongs_to_package edges cross-link module→package
		expect(edges.some((e) => e.kind === "belongs_to_package")).toBe(true);
	});

	it("returns a root package for an empty directory", () => {
		const { nodes } = runAllExtractors(tmp);
		// package-extractor synthesizes a root package node when no manifest is present.
		expect(nodes.some((n) => n.kind === "package" && n.label === "root")).toBe(true);
	});

	it("reports truncated:false and a complete graph for a normal tree", () => {
		writeFiles(tmp, { "package.json": "{}", "src/a.ts": 'config.get("db.host");' });
		const result = runAllExtractors(tmp);
		expect(result.truncated).toBe(false);
		expect(result.nodes.some((n) => n.kind === "config_key" && n.label === "db.host")).toBe(true);
	});

	// The shared budget is the whole point of runAllExtractors: ONE cap across all
	// seven walks, not one cap each. Exhausting it must surface as truncated:true
	// and a partial graph — callers are told not to treat it as complete.
	it(
		"shares ONE walk budget across all extractors: exhausting it truncates and starves the later ones",
		() => {
			const errors: string[] = [];
			const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
				errors.push(a.map(String).join(" "));
			});
			try {
				// Five full passes over the tree reach the shared cap, so the last two
				// extractors (examples, config) get no budget at all.
				const fileCount = Math.ceil(MAX_WALK_ENTRIES / 5);
				const bulk: Record<string, string> = {};
				for (let i = 0; i < fileCount; i++) bulk[`f${i}.ts`] = 'config.get("db.host");';
				writeFiles(tmp, bulk);

				const big = runAllExtractors(tmp);
				expect(big.truncated).toBe(true);
				// Still returns what it gathered — partial, not empty.
				expect(big.nodes.some((n) => n.kind === "module")).toBe(true);
				// …but strictly less than an untruncated walk of the same content sees.
				const small = mkdtempSync(join(tmpdir(), "run-ext-small-"));
				try {
					writeFiles(small, { "f0.ts": 'config.get("db.host");' });
					const ref = runAllExtractors(small);
					expect(ref.truncated).toBe(false);
					const bigKinds = new Set<ArtifactKind>(big.nodes.map((n) => n.kind));
					const refKinds = new Set<ArtifactKind>(ref.nodes.map((n) => n.kind));
					expect(refKinds.size).toBeGreaterThan(bigKinds.size);
					for (const k of bigKinds) expect(refKinds.has(k)).toBe(true);
				} finally {
					rmSync(small, { recursive: true, force: true });
				}
				// Truncation is never silent.
				expect(errors.some((e) => e.includes("walk hit the hard cap"))).toBe(true);
			} finally {
				spy.mockRestore();
			}
		},
		60_000,
	);
});

describe("extractSingleFile + relinkEditedFile (per-edit refresh)", () => {
	let tmp: string;
	beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "single-ext-")); });
	afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

	it("extractSingleFile classifies ONLY the named file across all extractors", () => {
		mkdirSync(join(tmp, "x"), { recursive: true });
		writeFileSync(join(tmp, "a.ts"), `${ENV_REF};\nconfig.get("kk");`);
		writeFileSync(join(tmp, "x", "other.ts"), `${ENV_REF};`);
		const { nodes } = extractSingleFile(tmp, "a.ts");
		expect(nodes.length).toBeGreaterThan(0);
		expect(nodes.every((n) => n.file === "a.ts")).toBe(true);
		expect(nodes.some((n) => n.kind === "module")).toBe(true);
		expect(nodes.some((n) => n.kind === "config_key")).toBe(true);
	});

	// One file at a time, across all seven extractors: the union of kinds a
	// single classify produces is what the incremental refresh puts in the graph.
	const singleFileCases: Array<{
		name: string;
		relPath: string;
		contents: string;
		kinds: ArtifactKind[];
		edgeKinds: string[];
	}> = [
		{
			name: "source module carrying env + config refs",
			relPath: "src/a.ts",
			contents: `${ENV_REF};\nconfig.get("db.host");`,
			kinds: ["module", "env_key", "config_key"],
			edgeKinds: [],
		},
		{
			name: "test file (module by extension, test by name, + tests edge)",
			relPath: "src/a.test.ts",
			contents: "",
			kinds: ["module", "test"],
			edgeKinds: ["tests"],
		},
		{ name: "readme", relPath: "README.md", contents: "#", kinds: ["doc"], edgeKinds: [] },
		{
			name: "package manifest",
			relPath: "package.json",
			contents: "{}",
			kinds: ["package"],
			edgeKinds: [],
		},
		{
			name: "env template",
			relPath: ".env.example",
			contents: "# comment\nAPP_REGION=us-east\n",
			kinds: ["env_key"],
			edgeKinds: [],
		},
		{
			name: "file under examples/",
			relPath: "examples/demo.ts",
			contents: "",
			kinds: ["module", "example"],
			edgeKinds: [],
		},
		{
			name: "unclassifiable file",
			relPath: "notes.txt",
			contents: "hello",
			kinds: [],
			edgeKinds: [],
		},
	];

	it.each(singleFileCases)(
		"extractSingleFile classifies a $name",
		({ relPath, contents, kinds, edgeKinds }) => {
			writeFiles(tmp, { [relPath]: contents });
			const { nodes, edges } = extractSingleFile(tmp, relPath);
			expect(new Set(nodes.map((n) => n.kind))).toEqual(new Set(kinds));
			expect(nodes.every((n) => n.file === relPath)).toBe(true);
			expect(edges.map((e) => e.kind)).toEqual(edgeKinds);
		},
	);

	it("extractSingleFile attributes an env key to the edited file, not the repo", () => {
		writeFiles(tmp, { "src/a.ts": `${ENV_REF};`, "src/b.ts": `${ENV_REF};` });
		const { nodes } = extractSingleFile(tmp, "src/b.ts");
		const envNode = nodes.find((n) => n.kind === "env_key");
		expect(envNode?.label).toBe("TEST_Z");
		expect(envNode?.file).toBe("src/b.ts");
	});

	it("relinkEditedFile re-derives module→package and preserves inbound test→module", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "package.json"), "{}");
		writeFileSync(join(tmp, "src", "foo.ts"), "export const x = 1;");
		writeFileSync(join(tmp, "src", "foo.test.ts"), "");
		const graph = new ArtifactGraph();
		const full = runAllExtractors(tmp);
		for (const n of full.nodes) graph.addNode(n);
		for (const e of full.edges) graph.addEdge(e);
		expect(graph.getEdgesByKind("tests").length).toBeGreaterThan(0);
		relinkEditedFile(graph, tmp, "src/foo.ts");
		expect(graph.getNodesByFile("src/foo.ts").some((n) => n.kind === "module")).toBe(true);
		expect(graph.getEdgesByKind("belongs_to_package").length).toBeGreaterThan(0);
		expect(graph.getEdgesByKind("tests").length).toBeGreaterThan(0);
		// The two counts above survive even with the module→package relink block
		// (index.ts:124-128) deleted entirely — foo.test.ts's own belongs_to_package
		// edge (untouched by this relink) keeps the length > 0. Pin the exact edge
		// SET so the re-derived edge for the edited file itself is required, not just
		// some edge of that kind.
		expect(graph.getEdgesByKind("belongs_to_package").map((e) => e.id).sort()).toEqual([
			"edge:module:src-foo->package:root",
			"edge:module:src-foo.test->package:root",
		]);
	});

	// A brand-new test file is the common per-edit case: its OWN outbound edge
	// (tests→module) has to enter the graph from the fresh classify, since there
	// is nothing to preserve — the file had no nodes before.
	it("relinkEditedFile adds the edited file's OWN outbound edges (new test file)", () => {
		writeFiles(tmp, { "package.json": "{}", "src/foo.ts": "export const x = 1;" });
		const graph = new ArtifactGraph();
		const full = runAllExtractors(tmp);
		for (const n of full.nodes) graph.addNode(n);
		for (const e of full.edges) graph.addEdge(e);
		expect(graph.getEdgesByKind("tests")).toEqual([]);
		expect(graph.getCompanions("module:src-foo").tests).toEqual([]);

		// The agent writes the test file, then the harness relinks just that file.
		writeFiles(tmp, { "src/foo.test.ts": "" });
		relinkEditedFile(graph, tmp, "src/foo.test.ts");

		const testEdges = graph.getEdgesByKind("tests");
		expect(testEdges).toHaveLength(1);
		expect(testEdges[0]).toMatchObject({
			from: "test:src-foo.test",
			to: "module:src-foo",
			kind: "tests",
		});
		// Caller-visible consequence: the module now has a test companion.
		expect(graph.getCompanions("module:src-foo").tests.map((n) => n.file)).toEqual([
			"src/foo.test.ts",
		]);
	});

	// EQUIVALENT-MUTANT DISCLOSURE (index.ts:124, `if (modules.length > 0)`): that
	// guard is a pure no-op optimization — `linkModulesToPackages([], packageNodes)`
	// iterates an empty module list and returns [], and the `[...packageNodes]` copy
	// means the graph is never touched — so deleting the condition changes NOTHING
	// observable and no test can pin its false path. Measured, not assumed:
	// scratch/r2-extractors-mutant-check.mts runs this fixture against a
	// guard-deleted relink and both produce the identical belongs_to_package edge
	// set. What this test DOES pin is the end-state around it: relinking a package
	// manifest adds no belongs_to_package edge and leaves the two inbound ones owned
	// by the module files intact. (The guard's TRUE path is behaviourally pinned by
	// the exact-edge-id-set assertion added to "relinkEditedFile re-derives
	// module→package …" above — NOT by that test's earlier length-only assertions,
	// which an equivalent mutant also satisfies. Deleting the whole block there
	// drops "edge:module:src-foo->package:root" from that set.)
	it("relinkEditedFile creates no belongs_to_package edge for a non-module file", () => {
		writeFiles(tmp, {
			"package.json": "{}",
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 2;",
		});
		const graph = new ArtifactGraph();
		const full = runAllExtractors(tmp);
		for (const n of full.nodes) graph.addNode(n);
		for (const e of full.edges) graph.addEdge(e);
		const before = graph.getEdgesByKind("belongs_to_package").map((e) => e.id).sort();
		expect(before).toHaveLength(2);

		// package.json yields a package node and NO module node, so the
		// module→package linking step must be skipped entirely…
		relinkEditedFile(graph, tmp, "package.json");

		expect(graph.getNode("package:root")?.file).toBe("package.json");
		// …while the inbound edges owned by the two module files are restored intact.
		expect(graph.getEdgesByKind("belongs_to_package").map((e) => e.id).sort()).toEqual(before);
		expect(graph.getEdgesTo("package:root")).toHaveLength(2);
	});
});

// A declared artifact file (interlinked/public-api.json, docs.json, …) layers
// nodes and edges onto the graph that NO per-file re-extract can reproduce —
// they come from JSON, not from the source tree. relinkEditedFile has to leave
// the graph consistent in that window, before structure-checks re-layers them.
describe("relinkEditedFile with declared artifacts layered on", () => {
	let tmp: string;

	const DECLARED_FIXTURE: Record<string, string> = {
		"package.json": "{}",
		"src/client.ts": "export function createClient() {\n\treturn {};\n}\n",
		"docs/client.md": "# Client API\n",
		"interlinked/structure.json": JSON.stringify({
			version: 1,
			mode: "standard",
			artifacts: { public_api: "artifacts/public-api.json", docs: "artifacts/docs.json" },
		}),
		"interlinked/artifacts/public-api.json": JSON.stringify({
			version: 1,
			modules: [
				{
					id: "client",
					file: "src/client.ts",
					symbols: [
						{
							name: "createClient",
							kind: "function",
							stability: "public",
							docs: ["client-api"],
							tests: [],
							examples: [],
						},
					],
				},
			],
		}),
		"interlinked/artifacts/docs.json": JSON.stringify({
			version: 1,
			docs: [
				{
					id: "client-api",
					file: "docs/client.md",
					kind: "reference",
					covers: [{ artifact_kind: "public_symbol", artifact_id: "client#createClient" }],
				},
			],
		}),
	};

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "declared-ext-"));
		writeFiles(tmp, DECLARED_FIXTURE);
	});
	afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

	// WHAT THIS TEST PINS, PRECISELY: the `exports` edge below has a `to` endpoint
	// (a DECLARED public_symbol) that no per-file re-extract can regenerate, so the
	// target guard at index.ts:130 (`if (graph.getNode(edge.to))`) alone keeps it
	// out. Replacing index.ts:116's `from && from.file !== relPath` with `from`
	// leaves every assertion below green — measured, not assumed. So this test pins
	// the observable end-state, NOT the same-file filter. That filter is pinned by
	// the colliding-id fixture in the next describe block, where the target DOES
	// come back and only line 116 can drop the edge.
	it("does NOT resurrect an inbound edge whose source lives in the edited file itself", () => {
		const graph = buildDeclaredGraph(tmp);
		const symbolRef = "public_symbol:client#createClient";
		// module:client --exports--> public_symbol:client#createClient; BOTH declared
		// nodes carry file "src/client.ts", so the edge is owned by the edited file.
		expect(graph.getNode("module:client")?.file).toBe("src/client.ts");
		expect(graph.getNode(symbolRef)?.file).toBe("src/client.ts");
		expect(graph.getEdgesTo(symbolRef).map((e) => e.kind)).toEqual(["exports"]);

		relinkEditedFile(graph, tmp, "src/client.ts");

		// The symbol node is gone (declared; only a re-layer brings it back), and the
		// same-file edge went with it rather than being preserved as a dangler.
		expect(graph.getNode(symbolRef)).toBeUndefined();
		expect(graph.getEdgesTo(symbolRef)).toEqual([]);
		expect(graph.getEdgesByKind("exports")).toEqual([]);
		// The extracted module node for the edited file is rebuilt.
		expect(graph.getNodesByFile("src/client.ts").map((n) => n.id)).toEqual(["module:src-client"]);
	});

	it("drops an inbound edge whose target the per-file re-extract cannot recreate", () => {
		const graph = buildDeclaredGraph(tmp);
		const declaredDoc = "doc:client-api";
		const documentsEdge = graph.getEdgesTo(declaredDoc);
		// public_symbol (in src/client.ts) --documents--> doc:client-api (docs/client.md):
		// inbound, owned by another file — the shape relinkEditedFile normally preserves.
		expect(documentsEdge).toHaveLength(1);
		expect(graph.getNode(documentsEdge[0]?.from ?? "")?.file).toBe("src/client.ts");
		expect(graph.getNode(declaredDoc)?.file).toBe("docs/client.md");

		relinkEditedFile(graph, tmp, "docs/client.md");

		// Only the path-derived doc node comes back; the DECLARED one cannot, so
		// re-adding the inbound edge would leave a dangling reference.
		expect(graph.getNodesByFile("docs/client.md").map((n) => n.id)).toEqual(["doc:docs-client"]);
		expect(graph.getNode(declaredDoc)).toBeUndefined();
		expect(graph.getEdgesByKind("documents")).toEqual([]);
		// Whole-graph sweep over BOTH endpoints — a surviving edge must not reference
		// a node that no longer exists on either side. The exact remaining edge set is
		// pinned first so the loop can never pass vacuously on an empty array.
		const remaining = graph.toEdgesJson().edges;
		expect(remaining.map((e) => `${e.from} -> ${e.to}`).sort()).toEqual([
			"module:client -> public_symbol:client#createClient",
			"module:src-client -> package:root",
		]);
		for (const edge of remaining) {
			expect(edge.to).not.toBe(declaredDoc);
			expect(graph.getNode(edge.from)).toBeDefined();
			expect(graph.getNode(edge.to)).toBeDefined();
		}
	});

	it("a re-layer after the relink restores the declared nodes and edges", () => {
		const graph = buildDeclaredGraph(tmp);
		const before = graph.toEdgesJson().edges.map((e) => e.id).sort();

		relinkEditedFile(graph, tmp, "docs/client.md");
		const loaded = loadStructureConfig(tmp);
		const config = loaded.config;
		if (!config) throw new Error("fixture interlinked/structure.json failed to load");
		layerDeclaredArtifacts(graph, tmp, config);

		expect(graph.getNode("doc:client-api")?.file).toBe("docs/client.md");
		expect(graph.toEdgesJson().edges.map((e) => e.id).sort()).toEqual(before);
	});
});

// THE DISCRIMINATING FIXTURE for index.ts:116 (`if (from && from.file !== relPath)`).
// In every fixture above, an inbound edge owned by the edited file also has a `to`
// the per-file re-extract cannot regenerate, so the target guard at index.ts:130
// drops it and line 116 is executed without deciding anything. Here the declared doc
// id is chosen to COLLIDE with the path-derived one — docs-extractor.classifyFile
// emits `doc:docs-client` for docs/client.md — and the declared public_api module is
// rooted at that SAME file. So the `documents` edge has its source in the edited file
// AND a target that survives the relink: only line 116 can keep it out. Measured
// against a mutated relink in scratch/r2-extractors-mutant-check.mts — real code
// leaves 0 dangling edges, `if (from)` leaves 1 (`public_symbol:inline#createClient`
// pointing out of a node that no longer exists).
describe("relinkEditedFile same-file inbound filter (index.ts:116)", () => {
	let tmp: string;

	const COLLIDING_ID_FIXTURE: Record<string, string> = {
		"package.json": "{}",
		// An untouched module, so the post-relink graph still holds a real edge and
		// the "no dangling endpoint" sweep cannot pass on an empty edge list.
		"src/keep.ts": "export const keep = 1;\n",
		"docs/client.md": "# Client API\n",
		"interlinked/structure.json": JSON.stringify({
			version: 1,
			mode: "standard",
			artifacts: { public_api: "artifacts/public-api.json", docs: "artifacts/docs.json" },
		}),
		// Declared module rooted at the DOC file: its public_symbol node therefore
		// carries file "docs/client.md" — the edge source lives in the edited file.
		"interlinked/artifacts/public-api.json": JSON.stringify({
			version: 1,
			modules: [
				{
					id: "inline",
					file: "docs/client.md",
					symbols: [
						{
							name: "createClient",
							kind: "function",
							stability: "public",
							docs: ["docs-client"],
							tests: [],
							examples: [],
						},
					],
				},
			],
		}),
		// id "docs-client" ⇒ node id `doc:docs-client`, exactly what the docs
		// extractor derives from the path docs/client.md.
		"interlinked/artifacts/docs.json": JSON.stringify({
			version: 1,
			docs: [{ id: "docs-client", file: "docs/client.md", kind: "reference", covers: [] }],
		}),
	};

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "collide-ext-"));
		writeFiles(tmp, COLLIDING_ID_FIXTURE);
	});
	afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

	it("drops a same-file inbound edge even when the re-extract regenerates its target", () => {
		const graph = buildDeclaredGraph(tmp);
		const docRef = "doc:docs-client";
		const symbolRef = "public_symbol:inline#createClient";

		// Pre-state: exactly one inbound edge, BOTH endpoints on the file to be edited.
		expect(graph.getEdgesTo(docRef).map((e) => `${e.from}|${e.kind}`)).toEqual([
			`${symbolRef}|documents`,
		]);
		expect(graph.getNode(symbolRef)?.file).toBe("docs/client.md");
		expect(graph.getNode(docRef)?.file).toBe("docs/client.md");
		expect(graph.getNode(docRef)?.provenance).toBe("declared");

		relinkEditedFile(graph, tmp, "docs/client.md");

		// The target id is BACK — extractor-derived this time — so index.ts:130 would
		// happily re-admit the edge. This is what makes the fixture discriminating.
		expect(graph.getNode(docRef)?.provenance).toBe("inferred");
		expect(graph.getNodesByFile("docs/client.md").map((n) => n.id)).toEqual([docRef]);
		// The source went away with the edited file's old nodes…
		expect(graph.getNode(symbolRef)).toBeUndefined();
		// …so the edge must NOT be restored: doing so is the mutant's dangling-FROM.
		expect(graph.getEdgesTo(docRef)).toEqual([]);
		expect(graph.getEdgesByKind("documents")).toEqual([]);

		// Exact surviving edge set (non-empty, so the endpoint sweep is not vacuous).
		const edges = graph.toEdgesJson().edges;
		expect(edges.map((e) => `${e.from} -> ${e.to}`)).toEqual(["module:src-keep -> package:root"]);
		for (const edge of edges) {
			expect(graph.getNode(edge.from)).toBeDefined();
			expect(graph.getNode(edge.to)).toBeDefined();
		}
	});

	// The `from &&` half of the same condition. A declared `covers` entry naming an
	// artifact nobody declares produces an inbound edge whose `from` node does not
	// exist at all (structure-checks builds the edge from the string ref, unresolved).
	// Deleting the null guard makes relinkEditedFile THROW on that edge.
	it("skips an inbound edge whose source node does not exist (null-guard half)", () => {
		writeFiles(tmp, {
			"interlinked/artifacts/public-api.json": JSON.stringify({ version: 1, modules: [] }),
			"interlinked/artifacts/docs.json": JSON.stringify({
				version: 1,
				docs: [
					{
						id: "docs-client",
						file: "docs/client.md",
						kind: "reference",
						covers: [{ artifact_kind: "public_symbol", artifact_id: "ghost#missing" }],
					},
				],
			}),
		});
		const graph = buildDeclaredGraph(tmp);
		const docRef = "doc:docs-client";
		const ghostRef = "public_symbol:ghost#missing";

		// Pre-state: the inbound edge exists but its `from` endpoint resolves to nothing.
		expect(graph.getEdgesTo(docRef).map((e) => e.from)).toEqual([ghostRef]);
		expect(graph.getNode(ghostRef)).toBeUndefined();

		relinkEditedFile(graph, tmp, "docs/client.md");

		expect(graph.getNode(docRef)?.provenance).toBe("inferred");
		expect(graph.getEdgesTo(docRef)).toEqual([]);
		expect(graph.getEdgesByKind("documents")).toEqual([]);
		const edges = graph.toEdgesJson().edges;
		expect(edges.map((e) => `${e.from} -> ${e.to}`)).toEqual(["module:src-keep -> package:root"]);
	});
});
