import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactGraph, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode } from "../types.js";
import { checkGlossaryResidue } from "./glossary-residue.js";
import { nonNull } from "../../../lib/non-null.js";

function termNode(label: string, deprecated: string[]): ArtifactNode {
	return {
		id: makeGlobalRef("term", label),
		kind: "term",
		label,
		file: "docs/glossary.md",
		provenance: "declared",
		determinism_ceiling: "fully_deterministic",
		metadata: { deprecated },
	};
}

describe("checkGlossaryResidue", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "gloss-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty when the graph has no term nodes", () => {
		const g = new ArtifactGraph();
		expect(checkGlossaryResidue(g, ["any.ts"], tmp)).toEqual([]);
	});

	it("returns empty when no changed file contains a deprecated term", () => {
		const g = new ArtifactGraph();
		g.addNode(termNode("Workspace", ["old_workspace"]));
		writeFileSync(join(tmp, "a.ts"), "const x = 1;");
		expect(checkGlossaryResidue(g, ["a.ts"], tmp)).toEqual([]);
	});

	it("flags a changed file that uses a deprecated term", () => {
		const g = new ArtifactGraph();
		g.addNode(termNode("Workspace", ["old_workspace"]));
		writeFileSync(join(tmp, "a.ts"), "const x = old_workspace;");
		const findings = checkGlossaryResidue(g, ["a.ts"], tmp);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).name).toBe("glossary_residue");
		expect(nonNull(findings[0]).severity).toBe("info");
	});

	it("is case-insensitive on the deprecated term", () => {
		const g = new ArtifactGraph();
		g.addNode(termNode("Workspace", ["old_workspace"]));
		writeFileSync(join(tmp, "a.ts"), "const x = OLD_WORKSPACE;");
		expect(checkGlossaryResidue(g, ["a.ts"], tmp)).toHaveLength(1);
	});

	it("tolerates missing files (read error -> no finding)", () => {
		const g = new ArtifactGraph();
		g.addNode(termNode("Workspace", ["old_workspace"]));
		expect(checkGlossaryResidue(g, ["does/not/exist.ts"], tmp)).toEqual([]);
	});
});
