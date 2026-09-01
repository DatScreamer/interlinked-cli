import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

// Public build protocol shared by the publisher and coalescing lease path.
export const BUILD_INPUT_MARKER = ".build-input-fingerprint";
const PACKAGE_IGNORE = ".npmignore";

const ENTRY_OUTPUTS = [
    "index.js",
    "harness/server.js",
    "harness/replay/inference-proxy.js",
    "harness/check-engine/tool-runners/tsc-overlay-sidecar-main.js",
    "lib/demo-runtime/index.js",
    "lib/viz/reporter-vitest.js",
    "hook-entry.js",
];

function lstatIfPresent(path) {
    try {
        return lstatSync(path);
    } catch (error) {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

function assertSafeDestination(destinationRoot, rel) {
    const rootStat = lstatIfPresent(destinationRoot);
    if (rootStat?.isSymbolicLink()) {
        throw new Error("Live distribution path must not be a symbolic link: dist");
    }
    if (rootStat !== null && !rootStat.isDirectory()) {
        throw new Error("Live distribution path must be a directory: dist");
    }

    let current = destinationRoot;
    const components = rel.split("/");
    for (const [index, component] of components.entries()) {
        current = join(current, component);
        const stat = lstatIfPresent(current);
        if (stat === null) break;
        if (stat.isSymbolicLink()) {
            throw new Error(`Live distribution path must not contain symbolic links: dist/${components.slice(0, index + 1).join("/")}`);
        }
        if (index < components.length - 1 && !stat.isDirectory()) {
            throw new Error(`Live distribution parent must be a directory: dist/${components.slice(0, index + 1).join("/")}`);
        }
    }
}

function assertPublicationPathsSafe(destinationRoot, files) {
    if (files.length === 0) assertSafeDestination(destinationRoot, ".build-preflight");
    for (const rel of files) assertSafeDestination(destinationRoot, rel);
}

function collectStageFiles(stage, current, out) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
        const absolute = join(current, entry.name);
        if (entry.isSymbolicLink() || lstatSync(absolute).isSymbolicLink()) {
            throw new Error(`Staged distribution must not contain symbolic links: ${relative(stage, absolute)}`);
        }
        if (entry.isDirectory()) collectStageFiles(stage, absolute, out);
        else if (entry.isFile()) out.push(relative(stage, absolute).split(sep).join("/"));
    }
}

function escapeIgnoreLiteral(path) {
    if (/[\0\r\n]/.test(path)) {
        throw new Error(`Staged distribution path cannot be represented safely in .npmignore: ${JSON.stringify(path)}`);
    }
    return path.replace(/([\\*?[\]{}()!#])/g, "\\$1");
}

/**
 * Keep every old hashed chunk addressable in live dist while making npm's
 * nested packlist exact for the newly built generation. The ignore file is
 * published in the same rollback-protected transaction as the entrypoints.
 */
export function writePackageFileAllowlist(stage) {
    const files = [];
    collectStageFiles(stage, stage, files);
    const currentFiles = files.filter((rel) => rel !== PACKAGE_IGNORE).sort();
    const directories = new Set();
    for (const rel of currentFiles) {
        const parts = rel.split("/");
        for (let depth = 1; depth < parts.length; depth += 1) {
            directories.add(parts.slice(0, depth).join("/"));
        }
    }
    const orderedDirectories = [...directories].sort((left, right) => {
        const depth = left.split("/").length - right.split("/").length;
        return depth || left.localeCompare(right);
    });
    const lines = [
        "**",
        ...orderedDirectories.map((rel) => `!/${escapeIgnoreLiteral(rel)}/`),
        ...currentFiles.map((rel) => `!/${escapeIgnoreLiteral(rel)}`),
    ];
    // interlinked: defer write_without_mkdir -- collectStageFiles just read
    // this exact stage directory successfully; the write is at its root.
    writeFileSync(join(stage, PACKAGE_IGNORE), `${lines.join("\n")}\n`);
}

function publicationPlan(stage) {
    const files = [];
    collectStageFiles(stage, stage, files);
    const entrySet = new Set(ENTRY_OUTPUTS);
    const shared = files
        .filter((rel) => !entrySet.has(rel) && rel !== BUILD_INPUT_MARKER && rel !== PACKAGE_IGNORE)
        .sort();
    const entries = [
        ...ENTRY_OUTPUTS.filter((rel) => files.includes(rel)),
        ...(files.includes(PACKAGE_IGNORE) ? [PACKAGE_IGNORE] : []),
    ];
    const marker = files.includes(BUILD_INPUT_MARKER) ? [BUILD_INPUT_MARKER] : [];
    return { shared, entries, marker, order: [...shared, ...entries, ...marker] };
}

function publishOne(stage, destinationRoot, rel) {
    const source = join(stage, rel);
    const destination = join(destinationRoot, rel);
    // Re-check immediately before each write as well as in the whole-plan
    // preflight. This closes the ordinary pre-existing-symlink case and
    // narrows the window for a concurrently introduced path redirect.
    assertSafeDestination(destinationRoot, rel);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
}

function publishFiles(stage, destinationRoot, files, beforePublishFile, startIndex) {
    let index = startIndex;
    for (const rel of files) {
        beforePublishFile(rel, index);
        publishOne(stage, destinationRoot, rel);
        index += 1;
    }
    return index;
}

function snapshotEntries(stage, destinationRoot, entries) {
    const backupRoot = join(stage, ".entry-backups");
    const existing = new Set();
    for (const rel of entries) {
        const destination = join(destinationRoot, rel);
        assertSafeDestination(destinationRoot, rel);
        if (lstatIfPresent(destination) === null) continue;
        const backup = join(backupRoot, rel);
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(destination, backup);
        existing.add(rel);
    }
    return { backupRoot, existing };
}

function restorePublishedEntries(destinationRoot, snapshot, published) {
    for (const rel of published.reverse()) {
        const destination = join(destinationRoot, rel);
        if (!snapshot.existing.has(rel)) {
            rmSync(destination, { force: true });
            continue;
        }
        renameSync(join(snapshot.backupRoot, rel), destination);
    }
}

function publishEntries(stage, destinationRoot, entries, beforePublishFile, startIndex) {
    const snapshot = snapshotEntries(stage, destinationRoot, entries);
    const published = [];
    try {
        for (const rel of entries) {
            beforePublishFile(rel, startIndex + published.length);
            publishOne(stage, destinationRoot, rel);
            published.push(rel);
        }
    } catch (error) {
        restorePublishedEntries(destinationRoot, snapshot, published);
        throw error;
    }
    return startIndex + published.length;
}

/**
 * Publish immutable/shared files first and runtime entrypoints last. Files are
 * atomically renamed over their own path; dist itself is never removed. Old
 * hashed chunks are deliberately retained for already-running lazy imports.
 */
export function publishRuntimeSafe(root, stage, { beforePublishFile = () => {} } = {}) {
    const destinationRoot = join(root, "dist");
    const plan = publicationPlan(stage);
    // Validate every existing live component before publishing even one
    // shared file. A nested symlink discovered late must not leave a partial
    // build or write through to a path outside dist.
    assertPublicationPathsSafe(destinationRoot, plan.order);
    mkdirSync(destinationRoot, { recursive: true, mode: 0o755 });
    const afterShared = publishFiles(stage, destinationRoot, plan.shared, beforePublishFile, 0);
    const afterEntries = publishEntries(stage, destinationRoot, plan.entries, beforePublishFile, afterShared);
    publishFiles(stage, destinationRoot, plan.marker, beforePublishFile, afterEntries);
    return plan.order;
}

export function publishedInputFingerprint(root) {
    const marker = join(root, "dist", BUILD_INPUT_MARKER);
    if (!existsSync(marker)) return null;
    return readFileSync(marker, "utf8").trim();
}
