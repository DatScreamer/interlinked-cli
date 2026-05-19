// UBS language-specific detectors — Python-language checks. Extracted from
// ubs-language-specific.ts during the 1500-line decomposition. Each function
// returns InlineMatch[]. Ext-gated to .py / .pyi.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	lineHasNoqaSuppression,
	stripCommentsAndStrings,
} from "../shared.js";
import { isNoqaSuppressedInRange, isPyFile, MATCH_LIMIT } from "./_shared.js";

// ===========================================
// Row 23 — `ubs_subprocess_shell_true` (Python)
// ===========================================

/**
 * Detect `subprocess.<fn>(... shell=True ...)` — command-injection vector.
 *
 * Plan 04 §4.1 regex: `\bsubprocess\.[a-z_]+\s*\([\s\S]{0,500}?\bshell\s*=\s*True\b`.
 * Widened to `[A-Za-z_]+` so `subprocess.Popen(...)` (uppercase entry point)
 * participates — the spec's lowercase form misses Popen, which is the most
 * common subprocess constructor in production code.
 *
 * The 500-char window covers calls split across many keyword-arg lines.
 */
export function checkSubprocessShellTrue(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".py" && ext !== ".pyi") return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const re = /\bsubprocess\.[A-Za-z_]+\s*\([\s\S]{0,500}?\bshell\s*=\s*True\b/g;

	for (const m of stripped.matchAll(re)) {
		if (matches.length >= 10) break;
		// Anchor at `shell` so the warning points at the dangerous keyword.
		const shellIdx = (m.index ?? 0) + m[0].lastIndexOf("shell");
		const lineNum = stripped.slice(0, shellIdx).split("\n").length;
		// 139-repo audit: respect Bandit `# noqa: S602 / S603` on any
		// line within the matched call (the suppression typically sits
		// on the opening line of a multi-line subprocess.run(...)).
		// Scan original lines from the call start to the match end.
		const callStartLine = stripped.slice(0, m.index ?? 0).split("\n").length;
		if (
			isNoqaSuppressedInRange(
				originalLines,
				callStartLine,
				lineNum,
				"ubs_subprocess_shell_true",
			)
		) {
			continue;
		}
		matches.push({
			line: lineNum,
			text: originalLines[lineNum - 1].trim().slice(0, 150),
		});
	}
	return matches;
}

// ===========================================
// Row 25 — `ubs_py_none_equality` (Python)
// ===========================================

/**
 * Detect `x == None` / `x != None` in Python — should be `is None` / `is not None`.
 *
 * Per PEP 8: comparisons to singletons (`None`, `True`, `False`) must use
 * `is`/`is not`, never `==`/`!=`. The latter triggers `__eq__` which can
 * return surprising results for proxy/mock objects.
 *
 * Plan 04 §4.1 regex: `\b\w+\s*[!=]=\s*None\b` (matches `x == None` / `x != None`).
 * Yoda style (`None == x` / `None != x`) is also flagged.
 */
export function checkPyNoneEquality(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".py" && ext !== ".pyi") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `\b\w+\s*(==|!=)\s*None\b` — identifier ==/!= None. Also covers Yoda.
	// Written as a non-capturing alternation rather than `[!=]=` so the
	// `ubs_js_loose_equality` detector (which lacks regex-literal stripping)
	// doesn't FP on this regex source line.
	const re = /\b\w+\s*(?:==|!=)\s*None\b|\bNone\s*(?:==|!=)\s*\w+/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (re.test(strippedLines[i])) {
			matches.push({
				line: i + 1,
				text: originalLines[i].trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * `ubs_python_mutable_default_arg` — `def f(x=[])` / `def f(x={})`.
 * post / warning.
 *
 * Python's default-argument values are evaluated ONCE at function-def
 * time. A mutable default ([] or {}) is shared across every invocation —
 * one of Python's classic gotchas. The detector matches `def NAME(args... = [])`
 * with a literal list/dict/set as default value.
 */
export function checkPyMutableDefaultArg(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".py") return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\bdef\s+\w+\s*\([^)]*=\s*(\[\s*\]|\{\s*\}|set\(\))/;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(originalLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_tempfile_mktemp_race` — Python `tempfile.mktemp()` is a TOCTOU
 * race-condition vector; the file path is returned without holding the file
 * open, so an attacker can win the race and substitute a symlink. pre_warn /
 * error.
 */
export function checkTempfileMktempRace(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\btempfile\.mktemp\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_pickle_untrusted_load` — Python `pickle.load(...)` / `pickle.loads(...)`
 * unpickles arbitrary bytes, which can execute attacker-controlled `__reduce__`
 * code on import. pre_warn / error.
 */
export function checkPickleUntrustedLoad(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	// Match pickle.load / pickle.loads / cPickle.load{,s}
	const re = /\b(?:c?[Pp]ickle|cPickle)\.loads?\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		// 139-repo audit: respect Bandit `# noqa: S301`.
		if (lineHasNoqaSuppression(originalLines[i], "ubs_pickle_untrusted_load")) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_xml_external_entity` — Python XML parsing without disabling external
 * entity resolution exposes the parser to XXE attacks. Fires when an unsafe
 * stdlib parser (`xml.etree`, `xml.dom`, `xml.sax`, `lxml.etree`) is BOTH
 * imported AND used to parse input (`ET.parse(...)`, `ET.fromstring(...)`,
 * `XMLParser(...)`, `XMLPullParser(...)`, `lxml.etree.parse(...)`,
 * `lxml.etree.fromstring(...)`). pre_warn / error.
 *
 * 139-repo audit (2026-05): an import-only gate produced 2 FPs in
 * Supermodel's `mcpbr/src/mcpbr/{junit_reporter,reporting}.py` — both
 * import `xml.etree.ElementTree as ET` only to BUILD/WRITE XML, never
 * to parse untrusted input. XXE risk requires actual parsing of
 * potentially-tainted input; writing XML is safe.
 */
const XML_PARSE_CALL_RE =
	/\b(?:ET|etree|xml\.etree(?:\.\w+)*|lxml\.etree)\s*\.\s*(?:parse|fromstring|XMLParser|XMLPullParser|iterparse)\s*\(|\bXMLPullParser\s*\(/;

export function checkXmlExternalEntity(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `import xml.etree...`, `from xml.etree...`, `from xml.dom...`,
	// `from xml.sax...`, or `from lxml import ...etree`.
	const re =
		/\b(?:import\s+xml\.(?:etree|dom|sax)|from\s+xml\.(?:etree|dom|sax)|from\s+lxml\b)/;

	// Skip files that already use defusedxml — the safe form.
	if (/\bdefusedxml\b/.test(stripped)) return [];

	// 139-repo audit: require an actual parse call somewhere in the
	// file. Import-only files (write-only XML reporters) are safe.
	if (!XML_PARSE_CALL_RE.test(stripped)) return [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		// 139-repo audit: respect Bandit `# noqa: S314 / S320`.
		if (lineHasNoqaSuppression(originalLines[i], "ubs_xml_external_entity")) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_os_system_tainted` — Python `os.system(x)` / `os.popen(x)` invoked with
 * a non-literal first argument (likely user input). Subprocess + shell=True
 * sibling: `os.system` always goes through `/bin/sh`, so any string
 * concatenation here is command-injection territory. pre_warn / error.
 */
export function checkOsSystemTainted(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// os.system(name) / os.popen(name) where the first arg is an identifier
	// (not a string literal — those were stripped by stripCommentsAndStrings).
	const re = /\bos\.(?:system|popen)\s*\(\s*[A-Za-z_]\w*/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_regex_in_loop_no_compile` — Python `re.match(pattern, ...)` /
 * `re.search(pattern, ...)` / `re.sub(pattern, ...)` invoked inside a `for`/
 * `while` loop without first calling `re.compile`. The regex is recompiled
 * on every iteration. post / warning.
 */
export function checkRegexInLoopNoCompile(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	let inLoop = false;
	let loopIndent = -1;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];
		const indent = line.search(/\S/);
		if (inLoop && indent !== -1 && indent <= loopIndent) {
			inLoop = false;
			loopIndent = -1;
		}
		if (/^\s*(?:for\b|while\b)/.test(line)) {
			inLoop = true;
			loopIndent = indent;
			continue;
		}
		if (inLoop && /\bre\.(?:match|search|sub|fullmatch|findall|finditer)\s*\(/.test(line)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}
