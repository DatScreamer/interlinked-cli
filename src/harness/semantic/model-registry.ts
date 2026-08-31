import { createHash } from "node:crypto";
import type { EmbeddingModelManifest } from "./types.js";

const NOMIC_REVISION = "0188c9bf409793f810680a5a431e7b899c46104c";
const NOMIC_SHA256 = "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac";

export const DEFAULT_SEMANTIC_MODEL_ALIAS = "nomic-embed-text-v1.5-q4";

export const EMBEDDING_MODEL_REGISTRY: readonly EmbeddingModelManifest[] = [
    {
        alias: DEFAULT_SEMANTIC_MODEL_ALIAS,
        modelId: "nomic-ai/nomic-embed-text-v1.5-GGUF",
        revision: NOMIC_REVISION,
        artifacts: [
            {
                url: `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/${NOMIC_REVISION}/nomic-embed-text-v1.5.Q4_K_M.gguf`,
                sha256: NOMIC_SHA256,
                bytes: 84_106_624,
                fileName: "nomic-embed-text-v1.5.Q4_K_M.gguf",
            },
        ],
        tokenizerSha256: NOMIC_SHA256,
        license: "Apache-2.0",
        dimension: 768,
        maxInputTokens: 8192,
        pooling: "mean",
        quantization: "Q4_K_M",
        runtime: "llama.cpp-cli-v1",
        inputSchemaVersion: "function-embedding-v1",
        documentPrefix: "search_document: ",
        queryPrefix: "search_query: ",
        experimental: true,
    },
];

export function modelReference(manifest: EmbeddingModelManifest): string {
    return `${manifest.alias}@${manifest.revision}`;
}

export function findModel(reference: string): EmbeddingModelManifest | undefined {
    const [alias, revision] = reference.split("@", 2);
    return EMBEDDING_MODEL_REGISTRY.find((candidate) =>
        candidate.alias === alias && (revision === undefined || candidate.revision === revision)
    );
}

export function modelFingerprint(manifest: EmbeddingModelManifest): string {
    const identity = {
        modelId: manifest.modelId,
        revision: manifest.revision,
        artifacts: manifest.artifacts.map((artifact) => artifact.sha256),
        tokenizerSha256: manifest.tokenizerSha256,
        pooling: manifest.pooling,
        quantization: manifest.quantization,
        dimension: manifest.dimension,
        runtime: manifest.runtime,
        inputSchemaVersion: manifest.inputSchemaVersion,
        aggregation: "weighted-centroid-v1",
        overlapPercent: 10,
    };
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
