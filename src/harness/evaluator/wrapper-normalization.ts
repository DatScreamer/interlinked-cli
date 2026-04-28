// ===========================================
// Wrapper-prefix normalization
// ===========================================
// Strip wrapper prefixes (`sudo`, `doas`, `env VAR=val`, `command -p`,
// `\cmd`) so a single rule pattern like `\brm -rf\b` matches `sudo rm -rf`
// without each rule re-encoding the `(?:sudo\s+)?` boilerplate. Idempotent.
// Plan 01 §1.1.

const WRAPPER_PREFIXES: ReadonlyArray<RegExp> = [
	/^sudo(?:\s+(?:-[a-zA-Z]+|--?[a-zA-Z][\w-]*(?:=\S+)?))*\s+/,
	/^doas(?:\s+(?:-[a-zA-Z]+|--?[a-zA-Z][\w-]*(?:=\S+)?))*\s+/,
	/^env(?:\s+[A-Z_][A-Z0-9_]*=\S+)+\s+/,
	/^command\s+-p\s+/,
	/^\\(?=[A-Za-z_])/,
];

export function normalizeCommandWrappers(cmd: string): string {
	let prev = "";
	let cur = cmd.trimStart();
	let safety = 8;
	while (cur !== prev && safety-- > 0) {
		prev = cur;
		for (const re of WRAPPER_PREFIXES) {
			const m = cur.match(re);
			if (m) {
				cur = cur.slice(m[0].length).trimStart();
				break;
			}
		}
	}
	return cur;
}
