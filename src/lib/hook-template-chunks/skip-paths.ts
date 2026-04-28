// Extracted into hooks-template.ts as a standalone chunk.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\*`, `\\.`, etc.) — they are the source form
// for the runtime script. `\\*` in this file becomes `\*` in the emitted .mjs.
//
// ===========================================
// Hook-side path skip (Phase B.3 — Free CLI Phase-2 roadmap)
// ===========================================
// Skips the daemon round-trip entirely for files in the user-configured
// `skip_paths` list (typically `dist/**`, `node_modules/**`, `**/*.min.js`,
// etc.). The .mjs is self-contained — no imports from the CLI package — so
// the matcher is a tiny inline glob implementation. Subagent Z's daemon-side
// matcher (src/lib/path-glob.ts, Phase B.2) implements the SAME glob syntax
// against the SAME schema (`{skip_paths: string[]}` in `.interlinked/config.json`).
//
// Glob syntax (must stay in lockstep with the daemon-side path-glob.ts):
//   `*`   — any number of non-separator characters (does NOT cross `/`)
//   `**`  — any number of characters including separators
//   `?`   — exactly one non-separator character
//   any other regex metachar is escaped to a literal match
//   (no brace expansion: `{js,ts}` is a literal substring, not alternation)
//
// Cache: parsed once per .mjs invocation (so re-reads of `config.json` don't
// happen on every event). The .mjs is short-lived (one invocation per tool
// call), so a per-process cache is sufficient — there's no long-running
// state to invalidate.

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const SKIP_PATHS_CHUNK = `// --- Hook-side path skip (Phase B.3) ---
// Reads .interlinked/config.json once per invocation and matches the touched
// file path against the configured \`skip_paths\` globs. On match, the hook
// short-circuits with {decision:"allow"} BEFORE opening the daemon socket —
// saving ~5 ms per excluded edit and eliminating daemon CPU work entirely.
// Same glob syntax (\`*\`, \`**\`, \`?\`) as the daemon-side path-glob.ts so
// the two matchers agree on what's excluded.

let SKIP_PATHS_CACHE = null;

function loadSkipPaths() {
    if (SKIP_PATHS_CACHE !== null) return SKIP_PATHS_CACHE;
    SKIP_PATHS_CACHE = [];
    try {
        if (!existsSync(CONFIG_SHARED_PATH)) return SKIP_PATHS_CACHE;
        const raw = readFileSync(CONFIG_SHARED_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.skip_paths)) {
            for (const entry of parsed.skip_paths) {
                if (typeof entry === "string" && entry.length > 0) {
                    SKIP_PATHS_CACHE.push(entry);
                }
            }
        }
    } catch (_err) { void 0; /* fail-open: bad config = no skipping, daemon still gates */ }
    return SKIP_PATHS_CACHE;
}

// Compile a single glob pattern to a RegExp. Mirrors path-glob.ts on the
// daemon side. Walks the pattern char-by-char so we can distinguish \`*\` from
// \`**\` and escape every non-glob metachar to a literal — the result is a
// fully-anchored RegExp that matches the entire path.
function globToRegex(pattern) {
    let re = "^";
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                // \`**\` — match any chars including \`/\`. Eat an optional
                // trailing slash so \`dist/**\` matches \`dist\` itself too.
                re += ".*";
                i += 2;
                if (pattern[i] === "/") i += 1;
            } else {
                // \`*\` — match non-separator chars only.
                re += "[^/]*";
                i += 1;
            }
        } else if (ch === "?") {
            re += "[^/]";
            i += 1;
        } else if ("\\\\^$.|+()[]{}".includes(ch)) {
            // Escape regex metachars to a literal match.
            re += "\\\\" + ch;
            i += 1;
        } else {
            re += ch;
            i += 1;
        }
    }
    re += "$";
    return new RegExp(re);
}

function matchesSkipPath(filePath) {
    if (!filePath || typeof filePath !== "string") return false;
    const patterns = loadSkipPaths();
    if (patterns.length === 0) return false;
    // Match against both the absolute path and a CWD-relative variant —
    // \`skip_paths\` entries like \`dist/**\` are written relative to the
    // project root but the agent emits absolute paths in tool_input.
    const cwdPrefix = CWD.endsWith("/") ? CWD : CWD + "/";
    const relative = filePath.startsWith(cwdPrefix) ? filePath.slice(cwdPrefix.length) : filePath;
    for (const pattern of patterns) {
        const re = globToRegex(pattern);
        if (re.test(filePath) || re.test(relative)) return true;
    }
    return false;
}

function emitSkipDebug(filePath, hookEvent) {
    if (!process.env.INTERLINKED_DEBUG) return;
    try {
        process.stderr.write("[interlinked:skip] " + hookEvent + " on " + filePath + " — matched skip_paths\\n");
    } catch (_err) { void 0; /* intentional: never block on debug logging */ }
}`;
