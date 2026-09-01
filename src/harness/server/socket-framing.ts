// ===========================================
// Raw-socket line framing
// ===========================================
// Extracted from server.ts. The raw Unix socket speaks newline-delimited
// JSON: a single TCP/socket chunk may carry zero, one, or many complete
// events, and an event may be split across chunks. This helper owns the
// buffer-accumulation + line-splitting state so the socket handler in
// server.ts stays a thin "for each complete line, evaluate it" loop — and so
// the framing edge cases (split mid-line, multiple lines per chunk, blank
// lines) are unit-testable without a live socket.
//
// Framing contract (unchanged since the inline `sock.on("data")` loop):
//   - lines are split on "\n"
//   - the trailing partial (no newline yet) stays buffered for the next chunk
//   - whitespace-only lines are dropped (the prior `if (!line.trim()) continue`)
//
// PERFORMANCE CONSTRAINT (2026-08-27 daemon-melt root cause): the partial
// line is held as an ARRAY of chunk pieces, never a growing string that is
// re-scanned. The prior `buffer += chunk; buffer.indexOf("\n")` forced V8 to
// flatten (memmove) the entire cons-string buffer on EVERY chunk — a single
// ~90MB one-line event arriving in ~64KB chunks cost ~1400 whole-buffer
// flattens (~tens of GB of copying) and drove the daemon into a GC storm the
// liveness probe reads as "zombie". Only the incoming chunk is scanned; the
// accumulated pieces are joined once, when their newline arrives.

/** Matches any non-whitespace character; used instead of `line.trim()` so a
 *  multi-MB line is not copied just to test blankness. */
const NON_BLANK = /\S/;

/** Accumulates socket chunks and yields complete, non-blank, newline-
 *  delimited lines. One instance per connection. */
export class LineFramer {
	/** Pieces of the current partial line (no "\n" inside any piece). */
	private parts: string[] = [];

	/** Append a decoded chunk and return every complete line it completed, in
	 *  order. Whitespace-only lines are dropped. Any trailing partial line
	 *  (text after the last newline) is retained for the next call. */
	push(chunk: string): string[] {
		const lines: string[] = [];
		let start = 0;
		let idx = chunk.indexOf("\n");
		while (idx !== -1) {
			let line = chunk.slice(start, idx);
			if (this.parts.length > 0) {
				this.parts.push(line);
				line = this.parts.join("");
				this.parts.length = 0;
			}
			if (NON_BLANK.test(line)) lines.push(line);
			start = idx + 1;
			idx = chunk.indexOf("\n", start);
		}
		if (start < chunk.length) {
			this.parts.push(start === 0 ? chunk : chunk.slice(start));
		}
		return lines;
	}

	/** The not-yet-terminated remainder. Exposed for assertions/diagnostics;
	 *  the socket handler never needs to read it directly. */
	get pending(): string {
		return this.parts.join("");
	}
}
