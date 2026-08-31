import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { semanticIndexStatus } from "./index-status.js";
import { semanticIndexRoot } from "./vector-store.js";

let temporary = "";

beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-status-"));
    process.env.INTERLINKED_MODEL_CACHE = join(temporary, "model-cache");
});

afterEach(() => {
    delete process.env.INTERLINKED_MODEL_CACHE;
    rmSync(temporary, { recursive: true, force: true });
});

describe("semantic index status", () => {
    it("reports a missing explicitly installed model without downloading it", async () => {
        const status = await semanticIndexStatus(temporary);

        expect(status.state).toBe("model-missing");
        expect(status.reason).toContain("model artifact is absent");
    });

    it("reports an unpublished build independently of model availability", async () => {
        mkdirSync(join(semanticIndexRoot(temporary), "generations", ".building-test"), { recursive: true });

        expect((await semanticIndexStatus(temporary)).state).toBe("building");
    });

    it("reports an unreadable CURRENT generation as corrupt", async () => {
        const root = semanticIndexRoot(temporary);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "CURRENT"), "missing-generation\n");

        const status = await semanticIndexStatus(temporary);
        expect(status.state).toBe("corrupt");
        expect(status.reason).toMatch(/no such file|ENOENT/i);
    });
});
