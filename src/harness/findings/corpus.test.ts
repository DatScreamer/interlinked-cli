import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findingsCorpusPath,
	foldByBugClass,
	getFinding,
	globalCorpusPath,
	loadFindings,
	makeFinding,
	recordFinding,
	upsertFinding,
} from "./corpus.js";

let cwd: string;
let home: string;
const prevHome = process.env.INTERLINKED_HOME;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "findings-cwd-"));
	home = mkdtempSync(join(tmpdir(), "findings-home-"));
	process.env.INTERLINKED_HOME = home;
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	if (prevHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = prevHome;
});

describe("paths", () => {
	it("corpus path is under .interlinked/findings", () => {
		expect(findingsCorpusPath(cwd)).toBe(join(cwd, ".interlinked", "findings", "corpus.jsonl"));
	});
	it("global path honors INTERLINKED_HOME override", () => {
		expect(globalCorpusPath()).toBe(join(home, ".interlinked", "findings-corpus.jsonl"));
	});
	it("global path falls back to homedir when INTERLINKED_HOME is unset", () => {
		delete process.env.INTERLINKED_HOME;
		expect(globalCorpusPath()).toBe(join(homedir(), ".interlinked", "findings-corpus.jsonl"));
	});
});

describe("makeFinding", () => {
	it("computes dedup_key, completeness, status, and a single provenance entry", () => {
		const f = makeFinding(
			{
				bug_class: "nan_coercion_guard",
				message: "Date.parse result compared without isFinite",
				file: "src/sponsor/types.ts",
				line: 42,
				severity: "high",
				category: "security",
				fix_instruction: "guard with Number.isFinite",
				source_runner: "github-inline",
				repo: "o/r",
				commit_sha: "abc123",
				lines: [42, 42],
				url: "https://example/x",
				quote: "if (Date.parse(x) > 0)",
				comment_author: "rev",
				created_at: "2026-06-17T00:00:00.000Z",
				actionability: "bug",
				now: "2026-06-17T00:00:00.000Z",
			},
			cwd,
		);
		expect(f.status).toBe("candidate");
		expect(f.provenance_tier).toBe("site");
		expect(f.dedup_key).not.toBe("");
		expect(f.times_observed).toBe(1);
		expect(f.provenance).toHaveLength(1);
		expect(f.provenance[0].provenance_completeness).toBe("anchored_sha");
		expect(f.source_runners).toEqual(["github-inline"]);
		expect(f.check).toBeNull();
		expect(f.category).toBe("security");
		expect(f.first_seen).toBe("2026-06-17T00:00:00.000Z");
	});
	it("derives a stable id from the same inputs", () => {
		const base = {
			bug_class: "nan_coercion_guard",
			message: "m",
			file: "a.ts",
			line: 5,
			source_runner: "paste",
		};
		expect(makeFinding(base, cwd).id).toBe(makeFinding(base, cwd).id);
	});
	it("normalizes an absolute file path to repo-relative", () => {
		const f = makeFinding(
			{ bug_class: "c", message: "m", file: join(cwd, "src/a.ts"), line: 1, source_runner: "paste" },
			cwd,
		);
		expect(f.file).toBe("src/a.ts");
	});
	it("derives line from lines[] when line is absent", () => {
		const f = makeFinding(
			{ bug_class: "c", message: "m", file: "a.ts", lines: [9, 11], source_runner: "paste" },
			cwd,
		);
		expect(f.line).toBe(9);
	});
	it("marks an unanchored prose finding class-tier with unknown severity default", () => {
		const f = makeFinding(
			{ bug_class: "some class!", message: "no locator", source_runner: "paste" },
			cwd,
		);
		expect(f.provenance_tier).toBe("class");
		expect(f.dedup_key).toBe("");
		expect(f.severity).toBe("unknown");
		expect(f.id).toMatch(/^some_class-/);
		expect(f.provenance[0].provenance_completeness).toBe("unanchored");
	});
});

describe("record + load round-trip", () => {
	it("writes to the local corpus and reads it back", () => {
		const f = makeFinding(
			{ bug_class: "c", message: "m", file: "a.ts", line: 1, source_runner: "paste" },
			cwd,
		);
		recordFinding(f, cwd, { mirrorGlobal: false });
		const loaded = loadFindings(cwd);
		expect(loaded).toHaveLength(1);
		expect(loaded[0].id).toBe(f.id);
	});
	it("mirrors to the global corpus when enabled", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd);
		expect(readFileSync(globalCorpusPath(), "utf-8")).toContain(f.id);
	});
	it("never throws when the global mirror fails (derived cache)", () => {
		// Make ~/.interlinked a regular FILE so mkdirSync of its child dir throws.
		writeFileSync(join(home, ".interlinked"), "blocker", "utf-8");
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		expect(() => recordFinding(f, cwd)).not.toThrow();
		expect(loadFindings(cwd)).toHaveLength(1);
	});
	it("loads from global and both scopes (dedup by id)", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd);
		expect(loadFindings(cwd, { scope: "global" }).map((x: { id: string }) => x.id)).toContain(f.id);
		expect(loadFindings(cwd, { scope: "both" })).toHaveLength(1);
	});
	it("skips torn / malformed JSONL lines (fail-open)", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd, { mirrorGlobal: false });
		writeFileSync(findingsCorpusPath(cwd), `${JSON.stringify(f)}\n{ not json\n`, "utf-8");
		expect(loadFindings(cwd)).toHaveLength(1);
	});
	it("skips valid JSON that is not a Finding (object + non-object)", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd, { mirrorGlobal: false });
		appendFileSync(findingsCorpusPath(cwd), `${JSON.stringify({ foo: 1 })}\nnull\n42\n[1,2]\n`, "utf-8");
		expect(loadFindings(cwd)).toHaveLength(1);
	});
	it("getFinding returns the row by id, null for unknown", () => {
		const f = makeFinding({ bug_class: "c", message: "m", source_runner: "paste" }, cwd);
		recordFinding(f, cwd, { mirrorGlobal: false });
		expect(getFinding(f.id, cwd)?.id).toBe(f.id);
		expect(getFinding("nope", cwd)).toBeNull();
	});
	it("returns [] when the corpus does not exist yet", () => {
		expect(loadFindings(cwd)).toEqual([]);
	});
});

describe("upsertFinding — idempotent merge", () => {
	const mk = (runner: string, c?: string) => ({
		bug_class: "nan_coercion_guard",
		message: "m",
		file: "a.ts",
		line: 7,
		source_runner: runner,
		repo: "o/r",
		...(c ? { commit_sha: c } : {}),
	});

	it("re-harvesting the same sighting does not double-count", () => {
		const a = makeFinding(mk("github-inline", "sha1"), cwd);
		upsertFinding(a, cwd, { mirrorGlobal: false });
		upsertFinding(makeFinding(mk("github-inline", "sha1"), cwd), cwd, { mirrorGlobal: false });
		expect(getFinding(a.id, cwd)?.times_observed).toBe(1);
	});

	it("appends a brand-new finding when none exists", () => {
		const merged = upsertFinding(makeFinding(mk("github-inline", "sha1"), cwd), cwd, {
			mirrorGlobal: false,
		});
		expect(merged.times_observed).toBe(1);
		expect(loadFindings(cwd)).toHaveLength(1);
	});

	it("a distinct external source at the same site grows times_observed + runners + aliases", () => {
		const a = makeFinding({ ...mk("github-inline", "sha1"), aliases: ["nan-cmp"] }, cwd);
		upsertFinding(a, cwd, { mirrorGlobal: false });
		const b = makeFinding({ ...mk("code-review-plugin", "sha2"), aliases: ["unguarded-nan"] }, cwd);
		expect(b.id).toBe(a.id);
		upsertFinding(b, cwd, { mirrorGlobal: false });
		const f = getFinding(a.id, cwd);
		expect(f?.times_observed).toBe(2);
		expect(f?.source_runners.sort()).toEqual(["code-review-plugin", "github-inline"]);
		expect(f?.aliases.sort()).toEqual(["nan-cmp", "unguarded-nan"]);
	});

	it("never raises severity on auto-merge (takes the less strict)", () => {
		upsertFinding(makeFinding({ ...mk("github-inline", "s1"), severity: "critical" }, cwd), cwd, {
			mirrorGlobal: false,
		});
		const lo = makeFinding({ ...mk("code-review-plugin", "s2"), severity: "low" }, cwd);
		upsertFinding(lo, cwd, { mirrorGlobal: false });
		expect(getFinding(lo.id, cwd)?.severity).toBe("low");
	});
});

describe("foldByBugClass", () => {
	it("groups findings across sites by canonical bug_class", () => {
		upsertFinding(
			makeFinding(
				{ bug_class: "nan_coercion_guard", message: "m", file: "a.ts", line: 1, source_runner: "paste" },
				cwd,
			),
			cwd,
			{ mirrorGlobal: false },
		);
		upsertFinding(
			makeFinding(
				{
					bug_class: "nan_coercion_guard",
					message: "m",
					file: "b.ts",
					line: 2,
					commit_sha: "s",
					lines: [2, 2],
					source_runner: "github-inline",
				},
				cwd,
			),
			cwd,
			{ mirrorGlobal: false },
		);
		const rows = foldByBugClass(loadFindings(cwd));
		expect(rows).toHaveLength(1);
		expect(rows[0].bug_class).toBe("nan_coercion_guard");
		expect(rows[0].finding_count).toBe(2);
		expect(rows[0].source_runners.sort()).toEqual(["github-inline", "paste"]);
		expect(rows[0].weakest_completeness).toBe("anchored_line");
		expect(rows[0].status_counts.candidate).toBe(2);
		expect(rows[0].sample_files.sort()).toEqual(["a.ts", "b.ts"]);
	});
	it("sorts classes by total observations descending", () => {
		upsertFinding(makeFinding({ bug_class: "rare", message: "m", source_runner: "paste" }, cwd), cwd, {
			mirrorGlobal: false,
		});
		upsertFinding(
			makeFinding({ bug_class: "common", message: "m", file: "x.ts", line: 1, source_runner: "a" }, cwd),
			cwd,
			{ mirrorGlobal: false },
		);
		upsertFinding(
			makeFinding({ bug_class: "common", message: "m", file: "y.ts", line: 1, source_runner: "b" }, cwd),
			cwd,
			{ mirrorGlobal: false },
		);
		const rows = foldByBugClass(loadFindings(cwd));
		expect(rows[0].bug_class).toBe("common");
	});
});
