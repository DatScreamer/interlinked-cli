// ===========================================
// Simplification contracts — pinned versions
// ===========================================

const MOVING_VERSION_ALIASES = new Set([
    "canary",
    "current",
    "default",
    "dev",
    "head",
    "latest",
    "main",
    "master",
    "next",
    "nightly",
    "stable",
]);

/** Accept exact semantic, date, digest, or vendor revisions while rejecting
 * package-manager ranges and moving aliases. Resolution belongs upstream. */
export function isPinnedExactVersion(value: string): boolean {
    if (value.length === 0 || value.trim() !== value || /\s/.test(value)) return false;
    if (MOVING_VERSION_ALIASES.has(value.toLowerCase())) return false;
    if (/[<>=~^*|]/.test(value)) return false;
    return !/(?:^|[._-])x(?:$|[._-])/i.test(value);
}
