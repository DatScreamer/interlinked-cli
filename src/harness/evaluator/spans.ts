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

export function classifySpans(cmd: string): Span[] {
	const spans: Span[] = [];
	let i = 0;
	let runStart = 0;
	let runKind: SpanKind = "executed";

	function flush(end: number, nextKind: SpanKind, nextStart: number): void {
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
	}

	while (i < cmd.length) {
		const c = cmd[i] as string;
		const c2 = cmd.slice(i, i + 2);

		if (c2 === HEREDOC_TOKEN && runKind === "executed") {
			const m = cmd.slice(i).match(/^<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/);
			if (m) {
				const tag = m[1] as string;
				const headerEnd = i + m[0].length;
				flush(headerEnd, "heredoc", headerEnd);
				const closer = new RegExp(`\\n${tag}(\\n|$)`);
				const after = cmd.slice(headerEnd);
				const closerMatch = after.match(closer);
				if (closerMatch && closerMatch.index !== undefined) {
					const closeAt = headerEnd + closerMatch.index;
					flush(closeAt, "executed", closeAt);
					i = closeAt;
					continue;
				}
				flush(cmd.length, "executed", cmd.length);
				i = cmd.length;
				break;
			}
		}

		if (c === COMMENT_CHAR && runKind === "executed") {
			const prev = i > 0 ? (cmd[i - 1] as string) : "";
			const isWordBoundary = prev === "" || /\s/.test(prev);
			if (isWordBoundary) {
				flush(i, "comment", i);
				const newline = cmd.indexOf("\n", i);
				const stop = newline === -1 ? cmd.length : newline;
				flush(stop, "executed", stop);
				i = stop;
				continue;
			}
		}

		if (c2 === ANSI_C_QUOTE && runKind === "executed") {
			flush(i, "quoted", i);
			i += 2;
			while (i < cmd.length) {
				if (cmd[i] === "\\" && i + 1 < cmd.length) {
					i += 2;
					continue;
				}
				if (cmd[i] === QUOTE_SINGLE) {
					i++;
					break;
				}
				i++;
			}
			flush(i, "executed", i);
			continue;
		}

		if (c === QUOTE_SINGLE && runKind === "executed") {
			flush(i, "quoted", i);
			i++;
			while (i < cmd.length && cmd[i] !== QUOTE_SINGLE) i++;
			if (i < cmd.length) i++;
			flush(i, "executed", i);
			continue;
		}

		if (c === QUOTE_DOUBLE && runKind === "executed") {
			flush(i, "quoted", i);
			i++;
			while (i < cmd.length) {
				if (cmd[i] === "\\" && i + 1 < cmd.length) {
					i += 2;
					continue;
				}
				if (cmd[i] === QUOTE_DOUBLE) {
					i++;
					break;
				}
				i++;
			}
			flush(i, "executed", i);
			continue;
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
