// Inline/line masking for the ref/link extractors (spec-facts substrate) —
// split out of extract-refs.ts for the per-file line cap.
//
// Two families, deliberately different layers (round-5 #18/#20; shaped by the
// adversarial-verify failure of the naive design):
//  • CHAR-level masks (column-preserving spaces, per line): code spans and
//    fully-contained `<!-- … -->` comments. Consumed ONLY by the section-ref
//    and anchor-link scanners — never by block-structure decisions. Masking a
//    trailing comment to spaces BEFORE underline detection turns
//    "Para\n--- <!-- c -->" into a phantom Setext heading and silently drops
//    live refs; keeping block decisions on RAW lines makes that impossible.
//  • LINE-level hidden set: whole-line HTML comment BLOCKS (the CommonMark
//    HTML block type 2 shape — a line starting `<!--` through the line
//    containing `-->`). Hidden rendered content: headings, refs, and links
//    inside must not exist. Comments OPENING mid-line and closing on a LATER
//    line are a residual (needs inline-aware block parsing); their open line
//    stays live, matching the pre-masking behavior.

/** Maximal backtick runs on one line as [start, length] pairs. */
export function backtickRuns(line: string): Array<[number, number]> {
	const runs: Array<[number, number]> = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === "`") {
			let j = i + 1;
			while (j < line.length && line[j] === "`") j++;
			runs.push([i, j - i]);
			i = j;
		} else {
			i++;
		}
	}
	return runs;
}

/** Run indices grouped by run length, in line order. */
function runIndexByLength(runs: Array<[number, number]>): Map<number, number[]> {
	const byLen = new Map<number, number[]>();
	for (let idx = 0; idx < runs.length; idx++) {
		const len = runs[idx]?.[1] ?? 0;
		const list = byLen.get(len);
		if (list) list.push(idx);
		else byLen.set(len, [idx]);
	}
	return byLen;
}

/** Mask code spans with spaces per CommonMark pairing: an opener run closes at
 *  the NEXT run of EXACTLY equal length; unequal runs in between are span
 *  content; an opener with no equal closer is literal text (round-5 #18 —
 *  "`§9``" contains NO code span, so its §9 stays live; the old regex paired
 *  unequal runs). Column-preserving. Linear: runs are collected once, closers
 *  found via per-length forward cursors (each cursor only advances), and
 *  masking is interval-collect plus one char pass — no per-span splicing.
 *  Multiline code spans remain a residual (per-line scanner). */
export function maskCodeSpans(line: string): string {
	if (!line.includes("`")) return line;
	const runs = backtickRuns(line);
	if (runs.length < 2) return line;
	const byLen = runIndexByLength(runs);
	const cursors = new Map<number, number>();
	const spans: Array<[number, number]> = [];
	let r = 0;
	while (r < runs.length) {
		const [start, len] = runs[r] ?? [0, 0];
		const list = byLen.get(len) ?? [];
		let c = cursors.get(len) ?? 0;
		while (c < list.length && (list[c] ?? 0) <= r) c++;
		cursors.set(len, c);
		const closer = list[c];
		if (closer === undefined) {
			r++; // no equal-length closer anywhere ahead — opener is literal
			continue;
		}
		const [cStart, cLen] = runs[closer] ?? [0, 0];
		spans.push([start, cStart + cLen]);
		r = closer + 1;
	}
	if (spans.length === 0) return line;
	const chars = line.split("");
	for (const [s, e] of spans) {
		for (let k = s; k < e; k++) chars[k] = " ";
	}
	return chars.join("");
}

/** Mask fully-contained `<!-- … -->` comments with spaces (column-preserving).
 *  An inline comment renders as nothing, so a literal example inside one must
 *  not produce refs/links (round-5 #20). Per-line form only — a comment whose
 *  `-->` sits on a later line is left untouched here (block-level handling and
 *  residuals live with htmlCommentBlockLines). */
export function maskInlineComments(line: string): string {
	if (!line.includes("<!--")) return line;
	let out = "";
	let i = 0;
	while (i < line.length) {
		const open = line.indexOf("<!--", i);
		if (open < 0) break;
		const close = line.indexOf("-->", open + 4);
		if (close < 0) break;
		out += line.slice(i, open) + " ".repeat(close + 3 - open);
		i = close + 3;
	}
	return out + line.slice(i);
}

/** The standard per-line mask for ref/link scanning: code spans first (they
 *  bind tighter — a comment inside a span is span content), then same-line
 *  comments. NEVER feed this to block-structure decisions. */
export function maskInlineIgnorable(line: string): string {
	return maskInlineComments(maskCodeSpans(line));
}

/** Lines (1-based) inside MULTILINE whole-line HTML comment blocks: an
 *  unfenced line whose first nonspace (≤3-space indent) is `<!--`, through the
 *  first line containing `-->`. The CommonMark HTML block type 2 shape —
 *  rendered invisible, so "<!--\n# Fake\n-->" must produce no heading, ref, or
 *  link (round-5 #20). A comment that CLOSES on its own opening line is NOT
 *  hidden here: its tail after `-->` is visible rendered text ("<!-- x --> and
 *  §3" shows "and §3"), and the char-level maskInlineComments already blanks
 *  the hidden span for the ref/link scanners. Tail text after `-->` on a
 *  multiline CLOSING line is a residual (whole line hidden). Linear. */
export function htmlCommentBlockLines(
	lines: string[],
	fencedLines: Set<number>,
): Set<number> {
	const hidden = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (fencedLines.has(i + 1)) continue;
		const line = lines[i] ?? "";
		if (!/^ {0,3}<!--/.test(line)) continue;
		if (line.indexOf("-->", line.indexOf("<!--") + 4) >= 0) continue; // same-line close: char-mask's beat
		hidden.add(i + 1);
		let j = i + 1;
		while (j < lines.length && !(lines[j] ?? "").includes("-->")) {
			hidden.add(j + 1);
			j++;
		}
		if (j < lines.length) hidden.add(j + 1); // the closing line
		i = j;
	}
	return hidden;
}

/** `fencedLines` ∪ comment-block lines — the skip set the extractors consult.
 *  Returns `fencedLines` itself when there are no comment blocks (the common
 *  case) so no per-file allocation is paid. */
export function withCommentBlockLines(
	lines: string[],
	fencedLines: Set<number>,
): Set<number> {
	const hidden = htmlCommentBlockLines(lines, fencedLines);
	if (hidden.size === 0) return fencedLines;
	for (const l of fencedLines) hidden.add(l);
	return hidden;
}
