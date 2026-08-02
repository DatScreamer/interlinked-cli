// @codegen-data — template-string carrier for the generated .mjs hook; no
// hand-written runtime logic to unit-test (exempts the every-file-tested gate).
// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\b`, `\\s`, `\\n`, etc.) — they are the source form
// for the runtime script. `\\b` in this file becomes `\b` in the emitted .mjs.

import { DESTRUCTIVE_COMMAND_GUARD_SOURCE } from "./destructive-command-guard.js";

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const GUARDS_INLINE_CHUNK = `/**
 * Inline fallback guard — comprehensive pattern matching covering all ~40 rules.
 * This is the PRIMARY guard — runs under Node.js on every tool call with zero dependencies.
 * When the harness is available, it provides additional quality checks and cohort awareness.
 */
/**
 * Fail-closed graph-prediction gate. When the harness daemon is unreachable,
 * the inline fallback below only knows about Bash shapes — file writes to
 * Supermodel-shard'd files would otherwise sail through unchallenged. This
 * check refuses Edit/Write/MultiEdit/NotebookEdit/apply_patch when the
 * target file has a colocated, fresh \`.graph.*\` shard, telling the user
 * to restart the harness so the protocol can run. Override via env:
 * INTERLINKED_DISABLE_GRAPH_SHARD_INLINE=1.
 */
function inlineGraphShardCheck(hookEvent, toolName, toolInput) {
    if (hookEvent !== "PreToolUse" && hookEvent !== "BeforeTool") return null;
    if (!toolName) return null;
    if (process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE === "1") return null;

    const FILE_WRITE_TOOLS = new Set([
        "Write", "Edit", "MultiEdit", "NotebookEdit",
        "WriteFile", "EditFile", "write_file", "edit_file",
        "FileWrite", "FileEdit", "create", "str_replace", "apply_patch",
    ]);
    if (!FILE_WRITE_TOOLS.has(toolName)) return null;

    // Extract target file path(s). For most tools it's tool_input.file_path;
    // for apply_patch the path is embedded in the patch body.
    const targets = [];
    const fp = toolInput?.file_path || toolInput?.filePath || toolInput?.path || toolInput?.target_file;
    if (typeof fp === "string" && fp.trim() !== "") targets.push(fp.trim());
    if (toolName === "apply_patch") {
        const patchBody = String(toolInput?.command || toolInput?.patch || toolInput?.content || toolInput?._raw_patch || "");
        const re = /^\\*\\*\\* (?:Update|Add|Delete) File:\\s+(.+)$/gm;
        let m;
        while ((m = re.exec(patchBody)) !== null) {
            const p = (m[1] || "").trim();
            if (p && !targets.includes(p)) targets.push(p);
        }
        const moveRe = /^\\*\\*\\* Move to:\\s+(.+)$/gm;
        while ((m = moveRe.exec(patchBody)) !== null) {
            const p = (m[1] || "").trim();
            if (p && !targets.includes(p)) targets.push(p);
        }
    }
    if (targets.length === 0) return null;

    const STALENESS_GRACE_MS = 60_000;
    for (const t of targets) {
        const abs = t.startsWith("/") ? t : require("node:path").resolve(process.cwd(), t);
        try {
            if (!existsSync(abs)) continue;
            const ext = abs.match(/\\.[^./]+$/)?.[0] || "";
            const shardPath = ext ? abs.slice(0, -ext.length) + ".graph" + ext : abs + ".graph";
            if (!existsSync(shardPath)) continue;
            const sourceMtime = statSync(abs).mtimeMs;
            const shardMtime = statSync(shardPath).mtimeMs;
            if (shardMtime < sourceMtime - STALENESS_GRACE_MS) continue;  // E-stale: not fail-closed
            // E-fresh + harness offline → block. Tell the user precisely how to recover.
            return {
                decision: "block",
                reason:
                    "[interlinked:graph-pred][harness-offline] Cannot evaluate the graph-prediction protocol because the harness daemon is unreachable, but " +
                    abs + " has a fresh Supermodel shard colocated. Edits to E-fresh files MUST go through the predict/reveal/reconcile loop. " +
                    "Start the harness with: interlinked harness start  (or restart it). Once it's up, retry your edit. " +
                    "Override (advanced, defeats the protocol): set INTERLINKED_DISABLE_GRAPH_SHARD_INLINE=1.",
                rule_id: "graph-prediction-inline-fail-closed",
                severity: "high",
                category: "graph-prediction",
            };
        } catch (_) {
            // intentional: best-effort — fs errors on shard probe must not break the hook
            continue;
        }
    }
    return null;
}

/**
 * Inline file-dump guard. Mirrors src/harness/evaluator/file-dump-guard.ts so
 * cold-fallback (harness daemon down) still refuses large/unfiltered dumps of
 * tail/head/cat output into the tool result. Three block conditions:
 *   1. tail -f / -F in the foreground (no trailing & and no nohup) — hangs.
 *   2. No filter & no redirect & file > 100KB — refuse regardless of -n.
 *   3. No filter & no redirect & lines requested > 50 — refuse.
 * Redirects (>) bypass the size checks; -c on tail/head counts as a filter.
 */
function inlineFileDumpCheck(hookEvent, toolName, toolInput) {
    if (hookEvent !== "PreToolUse" && hookEvent !== "BeforeTool") return null;
    if (!toolName) return null;
    var isBash = ["Bash", "Shell", "shell", "run_command"].indexOf(toolName) !== -1;
    if (!isBash) return null;
    var cmd = (toolInput && toolInput.command) || "";
    if (!cmd) return null;
    if (/^\\s*(tail|head|cat)\\b/.test(cmd) === false && /[;&|]\\s*(tail|head|cat)\\b/.test(cmd) === false) return null;

    var FILE_SIZE_BLOCK_BYTES = 100 * 1024;
    var NO_FILTER_MAX_LINES = 200;
    var FILTER_COMMANDS = ["jq","grep","egrep","fgrep","rg","ripgrep","ag","awk","gawk","mawk","sed","head","tail","wc","cut","sort","uniq","fzf","less","more"];
    var DUMP_VERBS = ["tail","head","cat"];

    function splitPipeline(s) {
        var out = [];
        var buf = "";
        var q = null;
        for (var i = 0; i < s.length; i++) {
            var ch = s[i];
            if (q) {
                buf += ch;
                if (ch === q) q = null;
                continue;
            }
            if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
            if (ch === "|") {
                if (s[i+1] === "|") { buf += "||"; i++; continue; }
                out.push(buf); buf = "";
                continue;
            }
            buf += ch;
        }
        if (buf.length) out.push(buf);
        return out;
    }

    function tokenize(seg) {
        var out = [];
        var buf = "";
        var q = null;
        for (var i = 0; i < seg.length; i++) {
            var ch = seg[i];
            if (q) {
                if (ch === q) { q = null; continue; }
                buf += ch;
                continue;
            }
            if (ch === '"' || ch === "'") { q = ch; continue; }
            if (/\\s/.test(ch)) {
                if (buf) { out.push(buf); buf = ""; }
                continue;
            }
            buf += ch;
        }
        if (buf) out.push(buf);
        return out;
    }

    function stripWrappers(tokens) {
        while (tokens.length) {
            var t = tokens[0];
            if (t === "sudo" || t === "exec" || t === "nohup" || t === "command") { tokens.shift(); continue; }
            if (t === "env") {
                tokens.shift();
                while (tokens[0] && /^[A-Za-z_]\\w*=/.test(tokens[0])) tokens.shift();
                continue;
            }
            if (/^[A-Za-z_]\\w*=/.test(t)) { tokens.shift(); continue; }
            break;
        }
    }

    function parseCount(tokens, shortFlag) {
        var longFlag = shortFlag === "-n" ? "--lines" : "--bytes";
        for (var i = 1; i < tokens.length; i++) {
            var t = tokens[i];
            if (t === shortFlag) {
                var n = tokens[i+1]; if (n === undefined) return null;
                var mm = n.match(/^\\+?(\\d+)\\b/);
                return mm ? parseInt(mm[1], 10) : null;
            }
            if (t.indexOf(shortFlag + "=") === 0) {
                var mm2 = t.slice(shortFlag.length+1).match(/^\\+?(\\d+)\\b/);
                return mm2 ? parseInt(mm2[1], 10) : null;
            }
            if (t.indexOf(shortFlag) === 0 && t.length > shortFlag.length && /^\\+?\\d/.test(t.charAt(shortFlag.length))) {
                var mm3 = t.slice(shortFlag.length).match(/^\\+?(\\d+)\\b/);
                return mm3 ? parseInt(mm3[1], 10) : null;
            }
            if (t.indexOf(longFlag + "=") === 0) {
                var mm4 = t.slice(longFlag.length+1).match(/^\\+?(\\d+)\\b/);
                return mm4 ? parseInt(mm4[1], 10) : null;
            }
            if (t === longFlag) {
                var n2 = tokens[i+1]; if (n2 === undefined) return null;
                var mm5 = n2.match(/^\\+?(\\d+)\\b/);
                return mm5 ? parseInt(mm5[1], 10) : null;
            }
        }
        return null;
    }

    var segments = splitPipeline(cmd);
    if (!segments.length) return null;
    var tokens = tokenize(segments[0] || "");
    stripWrappers(tokens);
    var verb = tokens[0];
    if (!verb || DUMP_VERBS.indexOf(verb) === -1) return null;

    if (verb === "tail") {
        var hasFollow = false;
        for (var ti = 1; ti < tokens.length; ti++) {
            var tt = tokens[ti];
            if (tt.indexOf("--") === 0) continue;
            if (tt.indexOf("-") !== 0) break;
            if (/[fF]/.test(tt.slice(1))) { hasFollow = true; break; }
        }
        if (hasFollow) {
            var trailingAmp = /(?:^|[^&])&\\s*$/.test(cmd);
            var nohup = /^\\s*nohup\\s+/.test(cmd);
            if (!trailingAmp && !nohup) {
                return {
                    decision: "block",
                    reason: "BLOCKED: tail -f in the foreground will hang the tool call indefinitely. " +
                        "Run it in the background (append ' &'), use the runner's background flag, " +
                        "or use the Monitor tool for streaming output.",
                    rule_id: "inline-tail-follow-foreground",
                    severity: "high",
                    category: "command-shape"
                };
            }
            return null;
        }
    }

    var hasRedirect = false;
    var qr = null;
    for (var ri = 0; ri < cmd.length; ri++) {
        var rc = cmd[ri];
        if (qr) { if (rc === qr) qr = null; continue; }
        if (rc === '"' || rc === "'") { qr = rc; continue; }
        if (rc === ">") {
            var prev = cmd[ri - 1];
            var next = cmd[ri + 1];
            if (next === "=" || prev === "=") continue;
            hasRedirect = true;
            break;
        }
    }
    if (hasRedirect) return null;

    var hasFilter = false;
    for (var si = 1; si < segments.length; si++) {
        var mm = segments[si].trim().match(/^([\\w.-]+)/);
        if (mm) {
            var raw = mm[1];
            var idx = raw.lastIndexOf("/");
            var name = idx >= 0 ? raw.slice(idx + 1) : raw;
            if (FILTER_COMMANDS.indexOf(name) !== -1) { hasFilter = true; break; }
        }
    }

    var cFlag = parseCount(tokens, "-c");
    if (cFlag !== null && (verb === "head" || verb === "tail")) hasFilter = true;
    var requestedLines = parseCount(tokens, "-n");

    var files = [];
    var bail = false;
    var flagsWithValue = ["-n","-c","--lines","--bytes"];
    for (var fi = 1; fi < tokens.length; fi++) {
        var ft = tokens[fi];
        if (!ft) continue;
        if (ft === "--") {
            for (var fj = fi+1; fj < tokens.length; fj++) if (tokens[fj]) files.push(tokens[fj]);
            break;
        }
        if (ft.indexOf("-") === 0) {
            if (flagsWithValue.indexOf(ft) !== -1) fi++;
            continue;
        }
        if (/[*?\\[\\]]/.test(ft)) { bail = true; break; }
        if (ft.indexOf("$") !== -1) { bail = true; break; }
        files.push(ft);
    }
    if (bail || !files.length) return null;

    var largestBytes = 0;
    var largestPath = "";
    var aggregateNewlines = 0;
    var catLineCountKnown = false;
    for (var k = 0; k < files.length; k++) {
        var fp = files[k];
        var abs = fp.charAt(0) === "/" ? fp : require("node:path").resolve(process.cwd(), fp);
        try {
            if (!existsSync(abs)) continue;
            var st = statSync(abs);
            if (!st.isFile()) continue;
            if (st.size > largestBytes) { largestBytes = st.size; largestPath = fp; }
            if (verb === "cat" && requestedLines === null && st.size <= FILE_SIZE_BLOCK_BYTES) {
                try {
                    var content = readFileSync(abs, "utf8");
                    var matches = content.match(/\\n/g);
                    aggregateNewlines += matches ? matches.length : 0;
                    catLineCountKnown = true;
                } catch (_) { /* leave catLineCountKnown false */ }
            }
        } catch (_) { /* best-effort */ }
    }
    var lines;
    if (requestedLines !== null) {
        lines = requestedLines;
    } else if (verb === "cat") {
        lines = catLineCountKnown ? aggregateNewlines : Infinity;
    } else {
        lines = 10;
    }

    function fmtBytes(b) {
        if (b < 1024) return b + "B";
        if (b < 1024*1024) return Math.round(b/1024) + "KB";
        return (b/(1024*1024)).toFixed(1) + "MB";
    }

    if (!hasFilter) {
        if (largestBytes > FILE_SIZE_BLOCK_BYTES) {
            return {
                decision: "block",
                reason: "BLOCKED: " + verb + " on " + largestPath + " (" + fmtBytes(largestBytes) + ") without a downstream filter would dump a large payload into the tool result. " +
                    "Pipe through one of: jq | grep | rg | awk | sed | head | wc | cut | sort | uniq. " +
                    "If you need the raw bytes on disk, redirect: " + verb + " ... > /tmp/sample. " +
                    "To check the file first, run: wc -l " + largestPath + ".",
                rule_id: "inline-file-dump-large-file",
                severity: "high",
                category: "command-shape"
            };
        }
        if (lines > NO_FILTER_MAX_LINES) {
            var linesDesc = lines === Infinity ? "an entire file" : (lines + " lines");
            return {
                decision: "block",
                reason: "BLOCKED: " + verb + " requesting " + linesDesc + " without a downstream filter caps out the tool-result budget. " +
                    "Cap at " + NO_FILTER_MAX_LINES + " lines, or narrow with a filter (jq / grep / awk / head). " +
                    "If you really need the raw bytes, redirect: " + verb + " ... > /tmp/sample.",
                rule_id: "inline-file-dump-too-many-lines",
                severity: "high",
                category: "command-shape"
            };
        }
    }

    return null;
}

/**
 * Inline merge-conflict guard. Mirrors evaluator/write-content-guards.ts
 * check A1 — a file written with merge-conflict markers is a guaranteed
 * parse error. The daemon blocks it; without this the cold fallback would
 * let it through. Covers Write (content), Edit (new_string), MultiEdit
 * (edits[].new_string) and NotebookEdit (new_source); apply_patch bodies
 * are left to the daemon (line-prefixed diff text needs different parsing).
 */
function inlineMergeConflictCheck(hookEvent, toolName, toolInput) {
    if (hookEvent !== "PreToolUse" && hookEvent !== "BeforeTool") return null;
    if (!toolName) return null;
    let content = "";
    if (typeof toolInput?.content === "string") content = toolInput.content;
    else if (typeof toolInput?.new_string === "string") content = toolInput.new_string;
    else if (typeof toolInput?.new_source === "string") content = toolInput.new_source;
    else if (Array.isArray(toolInput?.edits)) {
        content = toolInput.edits
            .map((e) => (e && typeof e.new_string === "string" ? e.new_string : ""))
            .join("\\n");
    }
    if (!content) return null;
    if (/^<{7}\\s|^={7}$|^>{7}\\s/m.test(content)) {
        const fp =
            toolInput?.file_path || toolInput?.filePath || toolInput?.path || "the target file";
        return {
            decision: "block",
            reason:
                "BLOCKED: Merge conflict markers detected in " +
                fp +
                ". Resolve the conflict before writing.",
            rule_id: "inline-merge-conflict-markers",
            severity: "high",
            category: "command-shape",
        };
    }
    return null;
}

// Destructive shell-command ladder — joined function declarations from
// src/lib/hook-template-chunks/destructive-command-guard.ts (the mask/shutdown
// helpers + one function per rule family + checkDestructiveCommand itself).
// This is the SAME source src/hook-entry.ts imports for its cold fallback, so
// the .mjs (harness-down) and hook-entry.ts cold paths cannot diverge. Spliced
// bare (no wrapping \`const x = \`) because the blob already contains a
// \`function checkDestructiveCommand(...) {}\` declaration; plain function
// declarations hoist so call order inside the blob doesn't matter.
${DESTRUCTIVE_COMMAND_GUARD_SOURCE}

/**
 * Inline supply-chain fail-closed gate. Daemon-down + a package-install
 * verb = block. Conservative: we can't reach the allowlist's full
 * decision logic from inside the .mjs template (the daemon-side parser
 * lives in src/harness/package-install-parser.ts), so when the daemon
 * is unreachable we refuse all install verbs and tell the user to
 * restart the harness. Bypass for one command via
 * INTERLINKED_DISABLE_PACKAGE_GUARD=1.
 */
function inlinePackageInstallCheck(hookEvent, toolName, toolInput) {
    if (hookEvent !== "PreToolUse" && hookEvent !== "BeforeTool") return null;
    if (process.env.INTERLINKED_DISABLE_PACKAGE_GUARD === "1") return null;
    if (!toolName) return null;
    const isBash = ["Bash", "Shell", "shell", "run_command"].indexOf(toolName) !== -1;
    if (!isBash) return null;
    const cmd = (toolInput && toolInput.command) || "";
    if (!cmd) return null;

    // Detect package-install verbs across the ten covered managers. This
    // mirrors the entry points of the daemon-side parser (any of these
    // would dispatch to a parser branch) — what we lose in granularity
    // (per-package allowlist match) we make up for in fail-closed safety.
    const INSTALL_RE = /\\b(?:npm|pnpm|yarn|bun)\\s+(?:install|i|add|ci)\\b|\\b(?:pip|pip3)\\s+install\\b|\\bpipx\\s+(?:install|inject|run)\\b|\\bpoetry\\s+(?:add|install)\\b|\\buv\\s+(?:add|sync|pip\\s+install|tool\\s+install)\\b|\\bcargo\\s+(?:add|install)\\b|\\bgem\\s+install\\b|\\bbundle(?:r)?\\s+(?:install|add)\\b|\\bgo\\s+(?:get|install)\\b/;
    // bare 'yarn' with no args also runs install:
    const BARE_YARN = /^\\s*(?:sudo\\s+|nohup\\s+|exec\\s+)?yarn\\s*(?:$|;|&|\\|)/;
    if (!INSTALL_RE.test(cmd) && !BARE_YARN.test(cmd)) return null;

    // Allow uninstall/remove explicitly — these don't add new code.
    if (/\\b(?:npm|pnpm|yarn|bun)\\s+(?:uninstall|remove|rm|un|unlink)\\b/.test(cmd)) return null;
    if (/\\bpip(?:3)?\\s+uninstall\\b/.test(cmd)) return null;
    if (/\\bpipx\\s+uninstall\\b/.test(cmd)) return null;
    if (/\\bpoetry\\s+remove\\b/.test(cmd)) return null;
    if (/\\buv\\s+remove\\b/.test(cmd)) return null;
    if (/\\bcargo\\s+(?:remove|uninstall)\\b/.test(cmd)) return null;
    if (/\\bgem\\s+uninstall\\b/.test(cmd)) return null;
    if (/\\bbundle(?:r)?\\s+remove\\b/.test(cmd)) return null;
    // Not 'npm run X', 'npm test', etc. — those are NOT install verbs and the
    // INSTALL_RE doesn't match them, but be explicit:
    if (/^\\s*npm\\s+(?:run|test|version|publish|view|outdated|audit|exec)\\b/.test(cmd)) return null;

    return {
        decision: "block",
        reason:
            "[interlinked:supply-chain][harness-offline] Package install commands are blocked when the harness daemon is unreachable, because the allowlist gate can't run. " +
            "Restart the harness with: interlinked harness start. Once it's up, retry — approved packages in .interlinked/package-allowlist.json will be allowed. " +
            "Override for one command (advanced, bypasses the gate): set INTERLINKED_DISABLE_PACKAGE_GUARD=1.",
        rule_id: "supply-chain-inline-fail-closed",
        severity: "high",
        category: "supply-chain",
    };
}

function inlineGuardDisabled() {
    try {
        for (const name of ["guard-disabled.local.json", "guard-disabled.json"]) {
            const p = join(CONFIG_DIR, name);
            if (!existsSync(p)) continue;
            const rec = JSON.parse(readFileSync(p, "utf-8"));
            if (!rec || rec.disabled !== true) continue;
            // Fail toward guarding on a malformed expiry: an unparseable expires_at
            // (NaN) must NOT read as a live stand-down (mirrors guard-state.ts).
            if (rec.expires_at !== undefined) { const exp = Date.parse(rec.expires_at); if (!Number.isFinite(exp) || exp <= Date.now()) continue; }
            return true;
        }
    } catch (_e) { /* malformed/unreadable -> fail toward guarding */ }
    return false;
}

function inlineGuardCheck(hookEvent, toolName, toolInput) {
    if (hookEvent !== "PreToolUse" && hookEvent !== "BeforeTool") return null;
    if (!toolName) return null;

    // Intentional, recorded stand-down (interlinked disable) honors the marker
    // so the operator can run unguarded here, mirroring the daemon + dist cold
    // gates. A crash leaves no marker, so the gates below still fail closed.
    if (inlineGuardDisabled()) return null;

    // Merge-conflict markers in file-write content are a guaranteed parse
    // error — mirror the daemon's write-content-guards A1 gate.
    const mergeBlock = inlineMergeConflictCheck(hookEvent, toolName, toolInput);
    if (mergeBlock) return mergeBlock;

    // Graph-prediction fail-closed gate. Runs early so file-write events
    // targeting a Supermodel-shard'd file get the protocol-restart message
    // instead of silently passing through the Bash-only path below.
    const shardBlock = inlineGraphShardCheck(hookEvent, toolName, toolInput);
    if (shardBlock) return shardBlock;

    // Supply-chain fail-closed gate. Daemon-down + package install = block.
    const supplyBlock = inlinePackageInstallCheck(hookEvent, toolName, toolInput);
    if (supplyBlock) return supplyBlock;

    // File-dump output-budget gate. Must run BEFORE the data-only references
    // skip below, since that skip returns null for any command starting with
    // tail/head/cat and would otherwise hide every dump-budget block.
    const dumpBlock = inlineFileDumpCheck(hookEvent, toolName, toolInput);
    if (dumpBlock) return dumpBlock;

    const isBash = ["Bash", "Shell", "shell", "run_command"].includes(toolName);
    if (!isBash) return null;

	const cmd = toolInput?.command || "";
	if (!cmd) return null;

	// Destructive shell-command ladder. checkDestructiveCommand is spliced in
	// above from src/lib/hook-template-chunks/destructive-command-guard.ts —
	// the SAME function src/hook-entry.ts imports for its cold fallback, so
	// the .mjs (harness-down) and hook-entry.ts cold paths cannot diverge.
	return checkDestructiveCommand(cmd);
}`;
