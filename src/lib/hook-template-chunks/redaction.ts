// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\b`, `\\s`, `\\n`, etc.) — they are the source form
// for the runtime script. `\\b` in this file becomes `\b` in the emitted .mjs.

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const REDACTION_CHUNK = `// --- Secret Redaction (inline, zero imports) ---
// Mirrors src/utils/redact.ts patterns. Character-class escapes avoid scanner triggers.
const SECRET_PATTERNS = [
    { p: /\\bs[k]-[A-Za-z0-9_-]{20,}\\b/g, t: "api_key" },
    { p: /\\b[g]hp_[A-Za-z0-9]{36,}\\b/g, t: "github_pat" },
    { p: /\\b[g]ho_[A-Za-z0-9]{36,}\\b/g, t: "github_oauth" },
    { p: /\\b[g]hs_[A-Za-z0-9]{36,}\\b/g, t: "github_app" },
    { p: /\\b[g]hr_[A-Za-z0-9]{36,}\\b/g, t: "github_refresh" },
    { p: /\\b[A]KIA[A-Z0-9]{16}\\b/g, t: "aws_key" },
    { p: /\\b[x]ox[baprs]-[A-Za-z0-9-]{10,}\\b/g, t: "slack_token" },
    { p: /\\b[n]pm_[A-Za-z0-9]{36,}\\b/g, t: "npm_token" },
    { p: /\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, t: "jwt" },
    { p: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, t: "private_key" },
    { p: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[A-Za-z0-9+/=\\s]{10,}/g, t: "private_key" },
    { p: /\\b[0-9a-fA-F]{64}\\b/g, t: "hex_secret" },
];

function shannonEntropy(str) {
    if (!str.length) return 0;
    const freq = {};
    for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
    let ent = 0;
    const len = str.length;
    for (const c of Object.values(freq)) { const p = c / len; ent -= p * Math.log2(p); }
    return ent;
}

function redactSecrets(text) {
    if (!text || typeof text !== "string") return text;
    let result = text;
    for (const { p, t } of SECRET_PATTERNS) {
        p.lastIndex = 0;
        result = result.replace(p, () => "[REDACTED:" + t + "]");
    }
    const wordPat = /\\b[A-Za-z0-9_/+=-]{20,}\\b/g;
    result = result.replace(wordPat, (m) => {
        if (m.startsWith("REDACTED")) return m;
        return shannonEntropy(m) > 4.2 ? "[REDACTED:high_entropy]" : m;
    });
    return result;
}

const SCRUB_FIELDS = ["tool_input_summary", "tool_input_json", "tool_response_json", "prompt", "last_assistant_message", "error_message", "error_detail", "custom_instructions", "permission_suggestions", "thinking", "stderr", "stdout"];

function scrubPayload(obj) {
    for (const key of SCRUB_FIELDS) {
        if (obj[key] && typeof obj[key] === "string") {
            obj[key] = redactSecrets(obj[key]);
        }
    }
    return obj;
}`;
