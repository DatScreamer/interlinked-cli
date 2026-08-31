import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSemanticModel, verifySemanticModelArtifact } from "./model-install.js";
import type { EmbeddingModelManifest } from "./types.js";

let temporary = "";
const previousCache = process.env.INTERLINKED_MODEL_CACHE;

afterEach(() => {
    vi.unstubAllGlobals();
    if (previousCache === undefined) delete process.env.INTERLINKED_MODEL_CACHE;
    else process.env.INTERLINKED_MODEL_CACHE = previousCache;
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    temporary = "";
});

function manifest(data: Buffer): EmbeddingModelManifest {
    return {
        alias: "test-model",
        modelId: "example/test-model",
        revision: "0123456789abcdef",
        artifacts: [{
            url: "https://huggingface.co/example/test-model/resolve/0123456789abcdef/model.gguf",
            sha256: createHash("sha256").update(data).digest("hex"),
            bytes: data.length,
            fileName: "model.gguf",
        }],
        tokenizerSha256: "tokenizer",
        license: "Apache-2.0",
        dimension: 2,
        maxInputTokens: 32,
        pooling: "mean",
        quantization: "test",
        runtime: "test",
        inputSchemaVersion: "function-embedding-v1",
        documentPrefix: "document: ",
        queryPrefix: "query: ",
        experimental: true,
    };
}

describe("semantic model acquisition", () => {
    it("size- and hash-verifies before atomically installing", async () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-model-"));
        process.env.INTERLINKED_MODEL_CACHE = temporary;
        const data = Buffer.from("verified model bytes");
        vi.stubGlobal("fetch", vi.fn(async () => new Response(data, {
            status: 200,
            headers: { "content-length": String(data.length) },
        })));
        const result = await installSemanticModel(manifest(data));
        expect(result.reused).toBe(false);
        expect(readFileSync(result.path)).toEqual(data);
        expect(existsSync(`${result.path}.verified.json`)).toBe(true);
        expect(await verifySemanticModelArtifact(manifest(data))).toBe(true);
        expect((await installSemanticModel(manifest(data))).reused).toBe(true);
    });

    it("refuses a redirect that leaves the allowlisted registry domains", async () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-model-"));
        process.env.INTERLINKED_MODEL_CACHE = temporary;
        const data = Buffer.from("model");
        const fetchMock = vi.fn(async () => new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/model.gguf" },
        }));
        vi.stubGlobal("fetch", fetchMock);
        await expect(installSemanticModel(manifest(data))).rejects.toThrow(/allowlisted/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("detects same-size model tampering before runtime load", async () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-model-"));
        process.env.INTERLINKED_MODEL_CACHE = temporary;
        const data = Buffer.from("trusted model bytes");
        const selected = manifest(data);
        vi.stubGlobal("fetch", vi.fn(async () => new Response(data, {
            status: 200,
            headers: { "content-length": String(data.length) },
        })));
        const installed = await installSemanticModel(selected);
        expect(await verifySemanticModelArtifact(selected)).toBe(true);
        writeFileSync(installed.path, Buffer.alloc(data.length, 7));
        const future = new Date(Date.now() + 5_000);
        utimesSync(installed.path, future, future);
        expect(await verifySemanticModelArtifact(selected)).toBe(false);
    });

    it("removes a temporary artifact after a hash mismatch", async () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-model-"));
        process.env.INTERLINKED_MODEL_CACHE = temporary;
        const expected = Buffer.from("right");
        const wrong = Buffer.from("wrong");
        vi.stubGlobal("fetch", vi.fn(async () => new Response(wrong, {
            status: 200,
            headers: { "content-length": String(wrong.length) },
        })));
        await expect(installSemanticModel(manifest(expected))).rejects.toThrow(/SHA-256/);
        expect(existsSync(join(temporary, "test-model", "0123456789abcdef", "model.gguf"))).toBe(false);
    });
});
