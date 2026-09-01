import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_WAIT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_STALE_MS = 30 * 60_000;
const DEFAULT_INITIALIZATION_GRACE_MS = 5_000;

// Public for lease diagnostics and focused stale-owner tests.
export function buildLeasePath(root) {
    return join(root, "node_modules", ".cache", "interlinked-build.lock");
}

function parseOwner(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const owner = value;
    if (typeof owner.token !== "string" || owner.token.length === 0) return null;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
    if (!Number.isFinite(owner.started_at_ms) || owner.started_at_ms < 0) return null;
    return { token: owner.token, pid: owner.pid, started_at_ms: owner.started_at_ms };
}

function readOwner(lockPath) {
    try {
        return parseOwner(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")));
    } catch {
        return null;
    }
}

function ownerRecordExists(lockPath) {
    try {
        statSync(join(lockPath, "owner.json"));
        return true;
    } catch {
        return false;
    }
}

function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
    }
}

function lockAgeMs(lockPath, owner, now) {
    if (owner) return Math.max(0, now - owner.started_at_ms);
    try {
        return Math.max(0, now - statSync(lockPath).mtimeMs);
    } catch {
        return 0;
    }
}

function reclaimIfStale(lockPath, { now, staleMs, initializationGraceMs, ownerAlive }) {
    const owner = readOwner(lockPath);
    if (owner !== null) {
        if (ownerAlive(owner.pid)) return false;
    } else {
        // mkdir() wins the lease before owner.json can be written. Give that
        // tiny initialization window its own short grace, while a present but
        // malformed owner record retains the ordinary corruption stale time.
        const reclaimAfterMs = ownerRecordExists(lockPath) ? staleMs : initializationGraceMs;
        if (lockAgeMs(lockPath, owner, now) < reclaimAfterMs) return false;
    }

    const quarantine = `${lockPath}.stale-${randomUUID()}`;
    try {
        renameSync(lockPath, quarantine);
    } catch {
        return false;
    }
    rmSync(quarantine, { recursive: true, force: true });
    return true;
}

function releaseOwnedLease(lockPath, token) {
    if (readOwner(lockPath)?.token !== token) return;
    rmSync(lockPath, { recursive: true, force: true });
}

function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function claimLease(lockPath, now) {
    mkdirSync(lockPath);
    const token = randomUUID();
    try {
        writeFileSync(
            join(lockPath, "owner.json"),
            `${JSON.stringify({ token, pid: process.pid, started_at_ms: now() })}\n`,
            { flag: "wx" },
        );
    } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
    }
    return { token, release: () => releaseOwnedLease(lockPath, token) };
}

/**
 * Cross-process repository build lease. Contenders wait instead of launching
 * another compiler; dead owners and old corrupt owner records are reclaimed.
 */
export async function acquireBuildLease(
    root,
    {
        waitMs = DEFAULT_WAIT_MS,
        pollMs = DEFAULT_POLL_MS,
        staleMs = DEFAULT_STALE_MS,
        initializationGraceMs = DEFAULT_INITIALIZATION_GRACE_MS,
        now = () => Date.now(),
        sleep = delay,
        ownerAlive = processIsAlive,
    } = {},
) {
    const lockPath = buildLeasePath(root);
    mkdirSync(dirname(lockPath), { recursive: true });
    const deadline = now() + waitMs;
    let waited = false;

    for (;;) {
        try {
            const claimed = claimLease(lockPath, now);
            return { waited, release: claimed.release };
        } catch (error) {
            const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
            if (code !== "EEXIST") throw error;
        }

        if (reclaimIfStale(lockPath, {
            now: now(),
            staleMs,
            initializationGraceMs,
            ownerAlive,
        })) continue;
        if (now() >= deadline) {
            throw new Error(`Another Interlinked build still owns ${lockPath}; waited ${waitMs}ms without launching a second compiler`);
        }
        waited = true;
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    }
}
