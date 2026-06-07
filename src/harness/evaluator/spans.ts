// ===========================================
// Shell command span classification
// ===========================================
// Walk a command character-by-character, classifying each byte range as
// `executed`, `quoted`, `comment`, or `heredoc`. Used by rule-matching to
// suppress false positives inside quoted strings and comments — `git
// commit -m 'rm -rf /'` should not fire `rm -rf` rules. Plan 01 §1.2.

export type SpanKind = "executed" | "quoted" | "comment" | "heredoc";

export interface Span {
	kind: SpanKind;
	start: number;
	end: number;
	text: string;
}

const QUOTE_SINGLE = "'";
const QUOTE_DOUBLE = '"';
const ANSI_C_QUOTE = "$'";
const COMMENT_CHAR = "#";
const HEREDOC_TOKEN = "<<";

// Closes the current run at `end` (pushing a span if non-empty) and re-opens a
// fresh run of `nextKind` starting at `nextStart`. Mutates the scanner state the
// closure captures in `classifySpans`.
type FlushFn = (end: number, nextKind: SpanKind, nextStart: number) => void;

// Each `scan*` byte-class handler below is invoked only while the scanner is in
// the `executed` state. It returns the index to resume at when it consumed a
// region, or `null` when its trigger byte(s) aren't present so the orchestrator
// can try the next handler (and finally advance one byte). Handlers themselves
// call `flush` to record the regions they consume.

/**
 * Scan an escaped-quote body: from `i` (positioned just past the opening quote)
 * to just past the matching `closer`, honoring backslash escapes. Returns the
 * index after the closing quote, or `cmd.length` if unterminated. Shared by the
 * double-quote and ANSI-C (`$'…'`) handlers, which differ only in their closer.
 */
function scanEscapedQuoteBody(cmd: string, i: number, closer: string): number {
	while (i < cmd.length) {
		if (cmd[i] === "\\" && i + 1 < cmd.length) {
			i += 2;
			continue;
		}
		if (cmd[i] === closer) {
			i++;
			break;
		}
		i++;
	}
	return i;
}

/** Heredoc: `<<TAG` / `<<-TAG` (optionally quoted tag). Body up to the closer is `heredoc`. */
function scanHeredoc(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd.slice(i, i + 2) !== HEREDOC_TOKEN) return null;
	const m = cmd.slice(i).match(/^<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/);
	if (!m) return null;
	const tag = m[1] as string;
	const headerEnd = i + m[0].length;
	flush(headerEnd, "heredoc", headerEnd);
	const closer = new RegExp(`\\n${tag}(\\n|$)`);
	const after = cmd.slice(headerEnd);
	const closerMatch = after.match(closer);
	if (closerMatch && closerMatch.index !== undefined) {
		const closeAt = headerEnd + closerMatch.index;
		flush(closeAt, "executed", closeAt);
		return closeAt;
	}
	flush(cmd.length, "executed", cmd.length);
	return cmd.length;
}

/** `#` comment — only at a word boundary — runs to end of line. */
function scanComment(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd[i] !== COMMENT_CHAR) return null;
	const prev = i > 0 ? (cmd[i - 1] as string) : "";
	const isWordBoundary = prev === "" || /\s/.test(prev);
	if (!isWordBoundary) return null;
	flush(i, "comment", i);
	const newline = cmd.indexOf("\n", i);
	const stop = newline === -1 ? cmd.length : newline;
	flush(stop, "executed", stop);
	return stop;
}

/** ANSI-C `$'…'` quoting (escape-aware, single-quote terminator). */
function scanAnsiCQuote(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd.slice(i, i + 2) !== ANSI_C_QUOTE) return null;
	flush(i, "quoted", i);
	const end = scanEscapedQuoteBody(cmd, i + 2, QUOTE_SINGLE);
	flush(end, "executed", end);
	return end;
}

/** `'…'` single quoting — literal, no backslash escapes. */
function scanSingleQuote(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd[i] !== QUOTE_SINGLE) return null;
	flush(i, "quoted", i);
	let j = i + 1;
	while (j < cmd.length && cmd[j] !== QUOTE_SINGLE) j++;
	if (j < cmd.length) j++;
	flush(j, "executed", j);
	return j;
}

/** `"…"` double quoting (escape-aware). */
function scanDoubleQuote(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd[i] !== QUOTE_DOUBLE) return null;
	flush(i, "quoted", i);
	const end = scanEscapedQuoteBody(cmd, i + 1, QUOTE_DOUBLE);
	flush(end, "executed", end);
	return end;
}

export function classifySpans(cmd: string): Span[] {
	const spans: Span[] = [];
	let i = 0;
	let runStart = 0;
	let runKind: SpanKind = "executed";

	const flush: FlushFn = (end, nextKind, nextStart) => {
		if (end > runStart) {
			spans.push({
				kind: runKind,
				start: runStart,
				end,
				text: cmd.slice(runStart, end),
			});
		}
		runKind = nextKind;
		runStart = nextStart;
	};

	while (i < cmd.length) {
		if (runKind === "executed") {
			const next =
				scanHeredoc(cmd, i, flush) ??
				scanComment(cmd, i, flush) ??
				scanAnsiCQuote(cmd, i, flush) ??
				scanSingleQuote(cmd, i, flush) ??
				scanDoubleQuote(cmd, i, flush);
			if (next !== null) {
				i = next;
				continue;
			}
		}
		i++;
	}
	flush(cmd.length, "executed", cmd.length);
	return spans.filter((s) => s.end > s.start);
}

export function extractScannableText(cmd: string, spans?: Span[]): string {
	const ss = spans ?? classifySpans(cmd);
	const buf: string[] = [];
	for (const s of ss) {
		if (s.kind === "executed") {
			buf.push(s.text);
		} else {
			buf.push(" ".repeat(s.end - s.start));
		}
	}
	return buf.join("");
}
