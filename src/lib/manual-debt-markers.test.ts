import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMeasurableDebtTrigger } from "./manual-debt-marker-parser.js";
import { scanManualDebtMarkers } from "./manual-debt-markers.js";

let root = "";

function write(rel: string, content: string): void {
    const absolute = join(root, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "manual-debt-markers-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("manual debt marker source scanning", () => {
    it("accepts source-aware decision and shortcut JSON comments", () => {
        write(
            "src/cache.ts",
            '// interlinked-debt: {"decision":"single-process cache","ceiling":"one process","trigger":"p95 > 50ms","owner":"platform"}\n',
        );
        write(
            "tools/job.py",
            '# interlinked-debt: {"shortcut":"serial execution","ceiling":"100 jobs","trigger":"queue >= 100 items"}\n',
        );
        const report = scanManualDebtMarkers({ cwd: root });
        expect(report.markers.map((marker) => marker.decision)).toEqual([
            "single-process cache",
            "serial execution",
        ]);
        expect(report.advisories).toEqual([]);
        expect(report.obligation_ledger).toEqual({ consulted: false, mutated: false });
        expect(report.coverage.scanned_paths).toEqual(["src/cache.ts", "tools/job.py"]);
    });

    it("reports malformed JSON and prose-only triggers as advisories", () => {
        write("src/bad.ts", "// interlinked-debt: not-json\n");
        write(
            "src/vague.ts",
            '// interlinked-debt: {"decision":"linear scan","ceiling":"small data","trigger":"when needed"}\n',
        );
        const report = scanManualDebtMarkers({ cwd: root });
        expect(report.markers).toEqual([]);
        expect(report.advisories.map((row) => row.code)).toEqual(["malformed-json", "no-trigger"]);
    });

    it("does not treat marker-looking string literals as source comments", () => {
        write(
            "src/string.ts",
            'const example = `// interlinked-debt: {"decision":"x","ceiling":"y","trigger":"n > 1"}`;\n',
        );
        const report = scanManualDebtMarkers({ cwd: root });
        expect(report.markers).toEqual([]);
        expect(report.advisories).toEqual([]);
    });

    it("ignores marker-looking lines inside multiline JavaScript and Python strings", () => {
        write(
            "src/template.ts",
            'const example = `documentation\n// interlinked-debt: {"decision":"x","ceiling":"y","trigger":"n > 1"}\n`;\n',
        );
        write(
            "tools/example.py",
            'example = """documentation\n# interlinked-debt: {"decision":"x","ceiling":"y","trigger":"n > 1"}\n"""\n',
        );
        const report = scanManualDebtMarkers({ cwd: root });
        expect(report.markers).toEqual([]);
        expect(report.advisories).toEqual([]);
    });

    it("does not parse Markdown prose as source debt markers", () => {
        write(
            "README.md",
            '<!-- interlinked-debt: {"decision":"example","ceiling":"none","trigger":"n > 1"} -->\n',
        );
        const report = scanManualDebtMarkers({ cwd: root });
        expect(report.markers).toEqual([]);
        expect(report.coverage.skipped.unsupported).toBe(1);
    });

	it("excludes generated, vendor, docs, examples, and custom paths", () => {
        const marker = '// interlinked-debt: {"decision":"x","ceiling":"y","trigger":"n > 1"}\n';
        write("generated/a.ts", marker);
        write("vendor/a.ts", marker);
        write("docs/a.ts", marker);
        write("examples/a.ts", marker);
        write("src/ignored/a.ts", marker);
        const report = scanManualDebtMarkers({ cwd: root, exclude: ["src/ignored"] });
        expect(report.markers).toEqual([]);
		expect(report.coverage.skipped.excluded).toBe(5);
	});

	it("counts an outside-project root without traversing it", () => {
		const outside = mkdtempSync(join(tmpdir(), "manual-debt-outside-"));
		try {
			writeFileSync(
				join(outside, "marker.ts"),
				'// interlinked-debt: {"decision":"x","ceiling":"y","trigger":"n > 1"}\n',
			);
			const report = scanManualDebtMarkers({ cwd: root, roots: [outside] });
			expect(report.markers).toEqual([]);
			expect(report.coverage.scanned_paths).toEqual([]);
			expect(report.coverage.skipped.outside_project).toBe(1);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

    it("keeps a fingerprint stable when unrelated lines move the marker", () => {
        const marker = '// interlinked-debt: {"decision":"x","ceiling":"y","trigger":"n > 1"}\n';
        write("src/a.ts", marker);
        const before = scanManualDebtMarkers({ cwd: root }).markers[0]?.fingerprint;
        write("src/a.ts", `const before = true;\n${marker}`);
        const after = scanManualDebtMarkers({ cwd: root }).markers[0]?.fingerprint;
        expect(before).toBeDefined();
        expect(after).toBe(before);
    });

    it("uses an explicit id for stable identity and a separate content fingerprint", () => {
        write(
            "src/cache.ts",
            '// interlinked-debt: {"id":"cache-bound","decision":"one cache","ceiling":"10k keys","trigger":"keys > 10000 items"}\n',
        );
        const before = scanManualDebtMarkers({ cwd: root }).markers[0];
        rmSync(join(root, "src", "cache.ts"));
        write(
            "lib/cache.ts",
            '// interlinked-debt: {"trigger":"keys > 20000 items","ceiling":"20k keys","decision":"one cache","id":"cache-bound"}\n',
        );
        const after = scanManualDebtMarkers({ cwd: root }).markers[0];
        expect(after?.fingerprint).toBe(before?.fingerprint);
        expect(after?.content_fingerprint).not.toBe(before?.content_fingerprint);
        expect(after?.file).toBe("lib/cache.ts");
    });

    it("excludes ambiguous duplicate explicit ids and reports every site", () => {
        const marker = '// interlinked-debt: {"id":"shared","decision":"x","ceiling":"y","trigger":"n > 1"}\n';
        write("src/a.ts", marker);
        write("src/b.ts", marker);
        const report = scanManualDebtMarkers({ cwd: root });
        expect(report.markers).toEqual([]);
        expect(report.advisories.map((row) => row.code)).toEqual([
            "duplicate-id",
            "duplicate-id",
        ]);
    });

    it("flags past review dates and links absent from the common findings corpus", () => {
        write(
            "src/cache.ts",
            '// interlinked-debt: {"id":"cache","decision":"one cache","ceiling":"10k keys","trigger":"keys > 10000 items","review_after":"2026-08-01","finding":"review-404"}\n',
        );
        const report = scanManualDebtMarkers({
            cwd: root,
            clock: () => Date.UTC(2026, 7, 30),
        });
        expect(report.markers).toHaveLength(1);
        expect(report.advisories.map((row) => row.code)).toEqual([
            "missing-finding",
            "stale-review",
        ]);
    });

    it("accepts a live linked finding and records repository/tree provenance", () => {
        execFileSync("git", ["init", "--quiet"], { cwd: root });
        write(
            "src/cache.ts",
            '// interlinked-debt: {"decision":"one cache","ceiling":"10k keys","trigger":"keys > 10000 items","finding":"review-1"}\n',
        );
        execFileSync("git", ["add", "."], { cwd: root });
        execFileSync(
            "git",
            ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"],
            { cwd: root },
        );
        const report = scanManualDebtMarkers({
            cwd: root,
            knownFindingIds: new Set(["review-1"]),
        });
        expect(report.advisories).toEqual([]);
        expect(report.repository).toEqual({
            root,
            head_sha: expect.stringMatching(/^[a-f0-9]{40,64}$/),
            tree_sha: expect.stringMatching(/^[a-f0-9]{40,64}$/),
            working_tree_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(report.read_only).toBe(true);
    });
});

describe("manual debt trigger measurability", () => {
    it("accepts explicit thresholds and rejects vague prose", () => {
        expect(isMeasurableDebtTrigger("p95 >= 200ms")).toBe(true);
        expect(isMeasurableDebtTrigger("after 30 days")).toBe(true);
        expect(isMeasurableDebtTrigger("when scale requires it")).toBe(false);
    });

    it("rejects impossible review dates and unknown fields", () => {
        write(
            "src/date.ts",
            '// interlinked-debt: {"decision":"x","ceiling":"y","trigger":"n > 1","review_after":"2026-02-30","extra":true}\n',
        );
        const report = scanManualDebtMarkers({ cwd: root });
        expect(report.markers).toEqual([]);
        expect(report.advisories.map((row) => row.code)).toEqual([
            "invalid-review-date",
            "unknown-field",
        ]);
    });
});
