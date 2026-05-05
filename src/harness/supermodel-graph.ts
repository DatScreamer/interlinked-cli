// ===========================================
// Supermodel `.graph.*` shard reader
// ===========================================
// Read-only consumer of Supermodel-emitted graph shards. We never write,
// generate, or modify graph files — Supermodel's daemon owns that lane.
// See `docs/plans/07-supermodel-graph-integration.md` for the integration
// rationale and `docs/integrations/supermodel.md` for the user-facing
// writeup. Format reference: reference-repos/supermodel-cli/internal/
// shards/render.go.

import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath, sep } from "node:path";

const MAX_SHARD_SIZE = 1024 * 1024;
const DOMAIN_SEPARATOR = " · ";

export interface SupermodelGraph {
	/** Absolute path of the shard file we read. */
	shardPath: string;
	/** Absolute path of the source the shard describes. */
	sourcePath: string;
	/** Parsed [impact] section, or null if the section is absent or unparseable. */
	impact: ImpactSection | null;
	/** Parsed [calls] section, or null if absent or unparseable. */
	calls: CallsSection | null;
	/** Parsed [deps] section, or null if absent or unparseable. */
	deps: DepsSection | null;
}

export interface ImpactSection {
	risk: "HIGH" | "MEDIUM" | "LOW";
	/** May be empty: Supermodel omits this field when the domain set is empty
	 *  (render.go:190). Parser treats absence as []. */
	domains: string[];
	/** File-granularity count: union of importers and files containing callers
	 *  of any function defined in the source. NOT a count of distinct caller
	 *  sites or import statements — see render.go:128-150 for the union
	 *  computation. */
	direct: number;
	/** Count of files transitively reachable through the import/call graph. */
	transitive: number;
	/** Listed files in the `direct` union. May be empty: Supermodel omits this
	 *  field when direct === 0 (render.go:197). Parser treats absence as []. */
	affects: string[];
}

export interface CallsSection {
	/** "FuncName ← CallerName    file:line" */
	callers: Array<{ fn: string; caller: string; file: string; line: number }>;
	/** "FuncName → CalleeName    file:line" */
	callees: Array<{ fn: string; callee: string; file: string; line: number }>;
}

export interface DepsSection {
	imports: string[];
	importedBy: string[];
}

/** Insert `.graph` before the extension. Mirrors Supermodel's ShardFilename
 *  (render.go:23). Operates on a string in/out — does not touch the
 *  filesystem. `src/Foo.tsx` → `src/Foo.graph.tsx`; an extension-less path
 *  like `Makefile` → `Makefile.graph`. */
export function shardPathFor(sourcePath: string): string {
	const ext = extname(sourcePath);
	if (!ext) return `${sourcePath}.graph`;
	const stem = sourcePath.slice(0, -ext.length);
	return `${stem}.graph${ext}`;
}

/** Read + parse a shard file for a source path.
 *
 *  `sourcePath` may be absolute or relative. `cwd` is required when the path
 *  is relative; the function resolves to absolute before deriving the shard
 *  filename and reading.
 *
 *  Returns null on any of:
 *   - missing source path / cwd needed but not provided
 *   - resolved path escapes cwd via traversal (defensive — only enforced
 *     when cwd is provided)
 *   - shard file does not exist or is not a regular file
 *   - shard file is larger than 1 MB (fail-open guard)
 *   - I/O error (permissions, etc.)
 *   - file contents have no recognizable header or sections
 *
 *  Section-level parse failures (e.g. malformed `risk` value, garbled
 *  `direct` field) null only the affected section. Never throws. */
export function loadGraphForFile(sourcePath: string, cwd?: string): SupermodelGraph | null {
	if (!sourcePath || sourcePath.trim() === "") return null;

	let absSource: string;
	if (isAbsolute(sourcePath)) {
		absSource = resolvePath(sourcePath);
	} else {
		if (!cwd) return null;
		absSource = resolvePath(cwd, sourcePath);
	}

	if (cwd) {
		const absCwd = resolvePath(cwd);
		const cwdPrefix = absCwd.endsWith(sep) ? absCwd : absCwd + sep;
		if (absSource !== absCwd && !absSource.startsWith(cwdPrefix)) return null;
	}

	const absShard = shardPathFor(absSource);

	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(absShard);
	} catch {
		return null;
	}
	if (!stats.isFile()) return null;
	if (stats.size > MAX_SHARD_SIZE) return null;

	let content: string;
	try {
		content = readFileSync(absShard, "utf8");
	} catch {
		return null;
	}

	return parseGraphFile(content, absSource, absShard);
}

/** Parse shard text. Exported for tests. Tolerant: unknown lines are ignored,
 *  unknown section names are ignored, malformed fields within a section null
 *  only that section. Returns null only when the input has no recognizable
 *  structure at all (no header, no sections). */
export function parseGraphFile(
	content: string,
	sourcePath: string,
	shardPath: string,
): SupermodelGraph | null {
	if (!content || content.trim() === "") return null;
	const rawLines = content.split(/\r?\n/);

	let cursor = 0;
	while (cursor < rawLines.length) {
		const t = rawLines[cursor].trim();
		if (t === "" || t === "//go:build ignore" || t === "package ignore") {
			cursor++;
			continue;
		}
		break;
	}
	if (cursor >= rawLines.length) return null;

	const firstLine = rawLines[cursor].trim();
	let prefix: string;
	if (firstLine.startsWith("//")) prefix = "//";
	else if (firstLine.startsWith("#")) prefix = "#";
	else return null;

	const stripped: string[] = [];
	for (let i = cursor; i < rawLines.length; i++) {
		const t = rawLines[i].trim();
		if (t === "") {
			stripped.push("");
			continue;
		}
		if (t.startsWith(prefix)) {
			stripped.push(t.slice(prefix.length).trim());
		} else {
			stripped.push("");
		}
	}

	let currentSection: "deps" | "calls" | "impact" | null = null;
	let sawSection = false;
	const depsLines: string[] = [];
	const callsLines: string[] = [];
	const impactLines: string[] = [];

	for (const line of stripped) {
		if (line === "") continue;
		if (line === "[deps]") {
			currentSection = "deps";
			sawSection = true;
			continue;
		}
		if (line === "[calls]") {
			currentSection = "calls";
			sawSection = true;
			continue;
		}
		if (line === "[impact]") {
			currentSection = "impact";
			sawSection = true;
			continue;
		}
		if (line.startsWith("[") && line.endsWith("]")) {
			currentSection = null;
			continue;
		}
		if (currentSection === "deps") depsLines.push(line);
		else if (currentSection === "calls") callsLines.push(line);
		else if (currentSection === "impact") impactLines.push(line);
	}

	if (!sawSection) {
		return { shardPath, sourcePath, impact: null, calls: null, deps: null };
	}

	return {
		shardPath,
		sourcePath,
		impact: parseImpact(impactLines),
		calls: parseCalls(callsLines),
		deps: parseDeps(depsLines),
	};
}

function parseDeps(lines: string[]): DepsSection | null {
	if (lines.length === 0) return null;
	const imports: string[] = [];
	const importedBy: string[] = [];
	for (const line of lines) {
		const [key, ...valueParts] = line.split(/\s+/);
		const value = valueParts.join(" ");
		if (!value) continue;
		if (key === "imports") imports.push(value);
		else if (key === "imported-by") importedBy.push(value);
	}
	if (imports.length === 0 && importedBy.length === 0) return null;
	return { imports, importedBy };
}

function parseCalls(lines: string[]): CallsSection | null {
	if (lines.length === 0) return null;
	const callers: CallsSection["callers"] = [];
	const callees: CallsSection["callees"] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let arrowIdx = trimmed.indexOf(" ← ");
		let direction: "caller" | "callee" | null = null;
		if (arrowIdx !== -1) direction = "caller";
		else {
			arrowIdx = trimmed.indexOf(" → ");
			if (arrowIdx !== -1) direction = "callee";
		}
		if (direction === null) continue;

		const fn = trimmed.slice(0, arrowIdx).trim();
		const rest = trimmed.slice(arrowIdx + 3).trim();
		if (!fn || !rest) continue;

		const restTokens = rest.split(/\s+/);
		if (restTokens.length === 0) continue;

		let other: string;
		let file = "";
		let lineNum = 0;
		if (restTokens.length === 1) {
			other = restTokens[0];
		} else {
			const last = restTokens[restTokens.length - 1];
			const colonIdx = last.lastIndexOf(":");
			if (colonIdx !== -1) {
				const linePart = last.slice(colonIdx + 1);
				const parsed = Number.parseInt(linePart, 10);
				if (Number.isFinite(parsed)) {
					file = last.slice(0, colonIdx);
					lineNum = parsed;
					other = restTokens.slice(0, -1).join(" ");
				} else {
					other = rest;
				}
			} else if (last === "?") {
				other = restTokens.slice(0, -1).join(" ");
			} else {
				other = rest;
			}
		}

		if (direction === "caller") callers.push({ fn, caller: other, file, line: lineNum });
		else callees.push({ fn, callee: other, file, line: lineNum });
	}

	if (callers.length === 0 && callees.length === 0) return null;
	return { callers, callees };
}

function parseImpact(lines: string[]): ImpactSection | null {
	if (lines.length === 0) return null;
	let risk: ImpactSection["risk"] | null = null;
	let domains: string[] = [];
	let direct: number | null = null;
	let transitive: number | null = null;
	let affects: string[] = [];
	let valid = true;

	for (const line of lines) {
		const trimmed = line.trim();
		const [key, ...valueParts] = trimmed.split(/\s+/);
		const value = valueParts.join(" ");

		switch (key) {
			case "risk":
				if (value === "HIGH" || value === "MEDIUM" || value === "LOW") {
					risk = value;
				} else {
					valid = false;
				}
				break;
			case "domains":
				if (value) {
					domains = value
						.split(DOMAIN_SEPARATOR)
						.map((d) => d.trim())
						.filter(Boolean);
				}
				break;
			case "direct": {
				const n = Number.parseInt(value, 10);
				if (Number.isFinite(n)) direct = n;
				else valid = false;
				break;
			}
			case "transitive": {
				const n = Number.parseInt(value, 10);
				if (Number.isFinite(n)) transitive = n;
				else valid = false;
				break;
			}
			case "affects":
				if (value) {
					affects = value
						.split(DOMAIN_SEPARATOR)
						.map((a) => a.trim())
						.filter(Boolean);
				}
				break;
		}
	}

	if (!valid) return null;
	if (!risk || direct === null || transitive === null) return null;
	return { risk, domains, direct, transitive, affects };
}
