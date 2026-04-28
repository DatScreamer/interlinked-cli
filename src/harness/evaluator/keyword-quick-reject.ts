// ===========================================
// Keyword quick-reject pre-pass
// ===========================================
// Pre-filter rules by keyword before running their regexes. Each guard rule
// can declare a `keywords: string[]` field; the rule is only evaluated if
// at least one keyword appears as a shell-tokenized word in the
// (wrapper-normalized) command. Empty/missing list = always evaluate.
// Plan 01 §1.3.

import type { GuardRule } from "../types.js";

// Quotes are token boundaries: `bash -c 'while :; do :; done'` must
// tokenize to {bash, -c, while, :, do, done} so a rule with
// keywords: ["while"] matches the inner shell command. Without
// `'"` in the boundary class, `'while` was a single token and the
// quick-reject pre-filter incorrectly skipped the rule. (Subagent D
// caught this on Plan 03 row 12 / infinite-spin.)
const TOKEN_BOUNDARY = /[\s|&;<>()`='"]+/;

export function commandKeywordTokens(cmd: string): Set<string> {
	const tokens = new Set<string>();
	for (const tok of cmd.toLowerCase().split(TOKEN_BOUNDARY)) {
		if (!tok || tok.length === 0) continue;
		tokens.add(tok);
		// Emit each path segment too: `/bin/dd`, `/usr/bin/docker`, and
		// `./terraform` should all expose `dd`, `docker`, `terraform` as
		// keyword candidates so a rule keyworded by the basename
		// (`["dd"]`, `["docker"]`, `["terraform"]`) still fires when the
		// command was invoked through an absolute or relative path.
		// Without this, `/bin/dd if=...` produced the single token
		// `/bin/dd`, the keyword set never contained `dd`, and the
		// destructive-dd rule's quick-reject pre-pass silently skipped
		// the regex evaluation.
		if (tok.includes("/")) {
			for (const segment of tok.split("/")) {
				if (segment && segment.length > 0) tokens.add(segment);
			}
		}
	}
	return tokens;
}

export function shouldEvaluateByKeywords(rule: GuardRule, tokens: Set<string>): boolean {
	const kws = rule.keywords;
	if (!kws || kws.length === 0) return true;
	for (const kw of kws) {
		if (tokens.has(kw.toLowerCase())) return true;
	}
	return false;
}
