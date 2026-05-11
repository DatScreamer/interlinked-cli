// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\b`, `\\s`, `\\n`, etc.) — they are the source form
// for the runtime script. `\\b` in this file becomes `\b` in the emitted .mjs.

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const GUARDS_INLINE_CHUNK = `/**
 * Inline fallback guard — comprehensive pattern matching covering all ~40 rules.
 * This is the PRIMARY guard — runs under Node.js on every tool call with zero dependencies.
 * When the harness is available, it provides additional quality checks and cohort awareness.
 */
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
    var NO_FILTER_MAX_LINES = 50;
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

function inlineGuardCheck(hookEvent, toolName, toolInput) {
    if (hookEvent !== "PreToolUse" && hookEvent !== "BeforeTool") return null;
    if (!toolName) return null;

    // File-dump output-budget gate. Must run BEFORE the data-only references
    // skip below, since that skip returns null for any command starting with
    // tail/head/cat and would otherwise hide every dump-budget block.
    const dumpBlock = inlineFileDumpCheck(hookEvent, toolName, toolInput);
    if (dumpBlock) return dumpBlock;

    const isBash = ["Bash", "Shell", "shell", "run_command"].includes(toolName);
    if (!isBash) return null;

	const cmd = toolInput?.command || "";
	if (!cmd) return null;

	function maskInlineQuotedShell(value) {
	    let out = "";
	    let quote = null;
	    let escaped = false;
	    let comment = false;
	    const backtick = String.fromCharCode(96);
	    for (let i = 0; i < value.length; i++) {
	        const ch = value[i];
	        if (comment) {
	            if (ch === "\\n") {
	                comment = false;
	                out += ch;
	            } else {
	                out += " ";
	            }
	            continue;
	        }
	        if (quote) {
	            if (escaped) {
	                escaped = false;
	                out += " ";
	                continue;
	            }
	            if (ch === "\\\\") {
	                escaped = true;
	                out += " ";
	                continue;
	            }
	            if (ch === quote) quote = null;
	            out += " ";
	            continue;
	        }
	        if (ch === "#" && (i === 0 || /\\s/.test(value[i - 1] || ""))) {
	            comment = true;
	            out += " ";
	            continue;
	        }
	        if (ch === "'" || ch === "\\"" || ch === backtick) {
	            quote = ch;
	            out += " ";
	            continue;
	        }
	        out += ch;
	    }
	    return out;
	}

	function matchesInlineShutdown(cmdValue) {
	    const masked = maskInlineQuotedShell(cmdValue);
	    const directRe = /(^|\\|\\||&&|[;|\\n])\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+|(?:bash|sh)\\s+-c\\s*["']?\\s*)*(shutdown|reboot|halt|poweroff|init\\s+[06]|systemctl\\s+(poweroff|reboot|halt))\\b/i;
	    const quotedShellRe = /(^|\\|\\||&&|[;|\\n])\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+)*(?:bash|sh)\\s+-c\\s*["']\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+)*(shutdown|reboot|halt|poweroff|init\\s+[06]|systemctl\\s+(poweroff|reboot|halt))\\b/i;
	    return directRe.test(masked) || quotedShellRe.test(cmdValue);
	}

	if (matchesInlineShutdown(cmd)) {
	    return { decision: "block", reason: "BLOCKED: System shutdown/reboot commands." };
	}

	// Context detection: skip data-only references (grep/echo/cat examining strings)
	if (/^\\s*(grep|egrep|fgrep|rg|ag|echo|printf|cat|head|tail|less|more|wc|diff|test|\\[)\\s/.test(cmd)) {
	    return null;
	}

    // --- Sleep ---
    if (/^\\s*(sleep|bash\\s+-c\\s+.*sleep)\\s+/i.test(cmd) || /;\\s*sleep\\s+/i.test(cmd)) {
        return { decision: "block", reason: "Do not use bash sleep. Use the wait_for_work MCP tool instead." };
    }

    // --- Process killing ---
    if (/\\b(killall|pkill|skill)\\s/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Mass process-killing commands (pkill/killall). Use 'kill <PID>' to target a single process." };
    }
    if (/\\bkill\\s+-[1-9][0-9]*\\b/.test(cmd) || /\\bkill\\s+-SIG/i.test(cmd) || /\\bkill\\s+-s\\s/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Sending termination signals. Use plain 'kill <PID>' (SIGTERM) instead." };
    }
    if (/\\bkill\\s+[0-9]+\\s+[0-9]+/.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Killing multiple PIDs at once. Kill one PID at a time." };
    }
    if (/\\bkill\\s+\\$\\(/.test(cmd) || /\\|\\s*xargs\\s+(.*\\s)?kill/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: kill with command substitution/xargs. Find the PID first, then kill it by number." };
    }
    if (/\\bpgrep\\b.*\\|\\s*xargs\\s+kill/i.test(cmd) || /\\bps\\s+(aux|ef)\\b.*\\|\\s*grep\\b.*\\|\\s*(awk|xargs|kill)/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Pattern kills processes system-wide. Use specific PID." };
    }

    // --- Filesystem destruction ---
    if (/\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--force\\s+--recursive)\\s/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Recursive force-delete (rm -rf). Use targeted, non-recursive removal." };
    }
    if (/\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*\\s+\\/(?!tmp\\b|var\\/tmp\\b)/i.test(cmd) || /\\brm\\s+-rf\\s+\\*/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Recursive deletion of root-level or wildcard paths. Be more specific." };
    }
    if (/\\brm\\s+(-[rf]+\\s+)*\\.wrangler\\s*($|&&|\\||;)/.test(cmd) || /\\brm\\s+(-[rf]+\\s+)*\\.wrangler\\/state\\b/.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: .wrangler contains the local development database. Try: rm -rf .wrangler/cache (keeps database)" };
    }
    if (/\\brm\\s+(-[rf]+\\s+)*node_modules\\s*($|&&|\\||;)/.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Deleting node_modules requires a full reinstall. Try: npm cache clean --force && npm install" };
    }
    if (/\\bdd\\s.*of=\\/dev\\//i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Writing directly to block devices with dd." };
    }
    if (/(^|\\s|;|&&)(mkfs|fdisk|parted|gdisk)\\s/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Disk formatting/partitioning commands." };
    }
    if (/\\bchmod\\s+(-R\\s+)?777\\s+\\//i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: chmod 777 on system paths is a security risk." };
    }
    if (/\\bsudo\\s+rm\\b/.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: sudo rm is extremely dangerous." };
    }

    // --- Git destruction ---
    if (/\\bgit\\s+push\\s+.*--force(?!-with-lease)\\b/i.test(cmd) || /\\bgit\\s+push\\s+-f\\s/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: git push --force. Use --force-with-lease instead." };
    }
    if (/\\bgit\\s+reset\\s+--hard\\b/.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: git reset --hard destroys all uncommitted changes. Use git stash first." };
    }
    if (/\\bgit\\s+clean\\s+-[a-zA-Z]*f/.test(cmd) && !/\\bgit\\s+clean\\s+.*(-n|--dry-run)/.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: git clean -f permanently deletes untracked files. Use git clean -n (dry-run) first." };
    }
    if (/\\bgit\\s+checkout\\s+--\\s+\\./.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: git checkout -- . discards all unstaged changes." };
    }
    if (/\\bgit\\s+restore\\s+--worktree\\s/.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: git restore --worktree discards working tree changes." };
    }
    if (/\\bgit\\s+branch\\s+-D\\s/.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: git branch -D force-deletes a branch without merge check. Use -d instead." };
    }
    if (/\\bgit\\s+stash\\s+(drop|clear)/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: git stash drop/clear permanently removes stashed work." };
    }

    // --- Database destruction ---
    if (/\\b(DROP\\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\\s+TABLE)/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Destructive database operations (DROP/TRUNCATE)." };
    }
    if (/\\bDELETE\\s+FROM\\s+\\w+\\s*;/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: DELETE without WHERE clause removes all rows." };
    }
    if (/\\b(dropDatabase|dropCollection)\\s*\\(/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: MongoDB drop operations." };
    }
    if (/\\bredis-cli\\s.*(FLUSHALL|FLUSHDB)/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Redis FLUSHALL/FLUSHDB clears all data." };
    }

    // --- Container/orchestration ---
    if (/\\bdocker\\s+(system|volume|image)\\s+prune/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: docker prune removes potentially important data." };
    }
    if (/\\bdocker[- ]compose\\s+down\\s+-v/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: docker-compose down -v removes volumes (data loss). Use 'down' without -v." };
    }
    if (/\\bkubectl\\s+delete\\s+(namespace|ns|all)\\s/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: kubectl mass deletion. Delete specific resources instead." };
    }
    if (/\\bkubectl\\s+drain\\s/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: kubectl drain evicts all pods from a node." };
    }

    // --- Infrastructure-as-Code ---
    if (/\\bterraform\\s+destroy/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: terraform destroy removes infrastructure." };
    }
    if (/\\bterraform\\s+apply\\s+.*-auto-approve/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: terraform apply -auto-approve skips human review." };
    }
    if (/\\bpulumi\\s+destroy/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: pulumi destroy removes infrastructure." };
    }

    // --- Cloud provider ---
    if (/\\baws\\s.*(terminate-instances|delete-db-instance|delete-stack|delete-bucket)/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: AWS destructive operations." };
    }
    if (/\\baws\\s+s3\\s+(rm|mv)\\s+.*--recursive/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Recursive S3 operations." };
    }
    if (/\\brsync\\s+.*--delete/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: rsync --delete can wipe files at the destination." };
    }

    // --- System-level ---
    // Mirrors the harness rule at builtin-rules-processes.ts so harness-up
    // and harness-down behavior agrees. Three pieces:
    //   1. Command-start anchor: ^, ;, &&, ||, single |, \\n. Excludes
    //      whitespace prefix to avoid FP on echo/grep strings.
    //   2. Optional wrapper chain: sudo, env [VAR=val ...], command, exec,
    //      nohup, bash -c "..., sh -c "...  — covers wrapped invocations
    //      like \`env FOO=1 reboot\` and \`bash -c reboot\` that an
    //      anchor-only regex misses.
    //   3. Verb with \\b so \`rebootloader\` doesn't match.
    if (/(^|\\|\\||&&|[;|\\n])\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+|(?:bash|sh)\\s+-c\\s*["']?\\s*)*(shutdown|reboot|halt|poweroff|init\\s+[06]|systemctl\\s+(poweroff|reboot|halt))\\b/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: System shutdown/reboot commands." };
    }
    if (/\\b(lvremove|vgremove|pvremove)\\s/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: LVM removal commands." };
    }

    // --- Embedded destructive commands ---
    if (/(python3?|node|ruby|perl)\\s+-(c|e)\\s+.*\\b(os\\.remove|shutil\\.rmtree|unlink|rimraf)\\b/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Inline script containing destructive file operations." };
    }
    if (/\\bbash\\s+-c\\s+.*\\b(rm\\s+-rf|killall|pkill)\\b/i.test(cmd)) {
        return { decision: "block", reason: "BLOCKED: Destructive command embedded in bash -c. Run directly so it can be properly reviewed." };
    }

    return null;
}`;
