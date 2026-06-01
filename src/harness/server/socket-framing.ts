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
// Behavior preserved verbatim from the prior inline `sock.on("data")` loop:
//   - lines are split on "\n"
//   - the trailing partial (no newline yet) stays buffered for the next chunk
//   - whitespace-only lines are dropped (the prior `if (!line.trim()) continue`)

/** Accumulates socket chunks and yields complete, non-blank, newline-
 *  delimited lines. One instance per connection. */
export class LineFramer {
	private buffer = "";

	/** Append a decoded chunk and return every complete line it completed, in
	 *  order. Whitespace-only lines are dropped. Any trailing partial line
	 *  (text after the last newline) is retained for the next call. */
	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];
		let newlineIdx = this.buffer.indexOf("\n");
		while (newlineIdx !== -1) {
			const line = this.buffer.slice(0, newlineIdx);
			this.buffer = this.buffer.slice(newlineIdx + 1);
			if (line.trim()) lines.push(line);
			newlineIdx = this.buffer.indexOf("\n");
		}
		return lines;
	}

	/** The not-yet-terminated remainder. Exposed for assertions/diagnostics;
	 *  the socket handler never needs to read it directly. */
	get pending(): string {
		return this.buffer;
	}
}
