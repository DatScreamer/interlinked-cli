import { matchesGlob } from "../../lib/path-glob.js";
import { loadSemanticConfig } from "./config.js";
import { normalizeVector } from "./embed-function.js";
import { semanticIndexStatus } from "./index-status.js";
import { createLlamaRuntime } from "./runtime.js";
import type {
    IndexedFunctionRow,
    LoadedSemanticIndex,
    SemanticSearchResult,
} from "./types.js";
import { loadSemanticIndex } from "./vector-store.js";

export interface SemanticSearchOptions {
    top?: number;
    language?: string;
    path?: string;
}

export interface SemanticSearchResponse {
    schemaVersion: 1;
    fingerprint: string;
    stale: boolean;
    results: SemanticSearchResult[];
}

function dotAt(query: Float32Array, vectors: Float32Array, offset: number, dimension: number): number {
    let score = 0;
    const start = offset * dimension;
    for (let index = 0; index < dimension; index++) {
        score += (query[index] ?? 0) * (vectors[start + index] ?? 0);
    }
    return score;
}

function selectRows(index: LoadedSemanticIndex, options: SemanticSearchOptions, excludedId?: string): IndexedFunctionRow[] {
    return index.rows.filter((row) => row.id !== excludedId
        && (options.language === undefined || row.language === options.language)
        && (options.path === undefined || matchesGlob(row.file, options.path)));
}

function rankedResults(
    index: LoadedSemanticIndex,
    query: Float32Array,
    options: SemanticSearchOptions,
    stale: boolean,
    excludedId?: string,
): SemanticSearchResult[] {
    const top = Math.min(100, Math.max(1, options.top ?? 10));
    return selectRows(index, options, excludedId)
        .map((row) => ({ row, score: dotAt(query, index.vectors, row.vectorOffset, index.meta.dimension) }))
        .sort((a, b) => b.score - a.score
            || a.row.file.localeCompare(b.row.file)
            || a.row.line - b.row.line
            || a.row.qualifiedName.localeCompare(b.row.qualifiedName))
        .slice(0, top)
        .map(({ row, score }, resultIndex) => ({
            rank: resultIndex + 1,
            score,
            file: row.file,
            symbol: row.qualifiedName,
            line: row.line,
            endLine: row.endLine,
            language: row.language,
            canonicalTokens: row.canonicalTokens,
            modelTokens: row.modelTokens,
            chunkCount: row.chunkCount,
            stale,
        }));
}

async function queryableIndex(root: string): Promise<{ index: LoadedSemanticIndex; stale: boolean }> {
    const status = await semanticIndexStatus(root);
    if (status.state !== "current" && status.state !== "stale") {
        throw new Error(`semantic index is not queryable (${status.state})${status.reason ? `: ${status.reason}` : ""}`);
    }
    return { index: loadSemanticIndex(root, status.modelFingerprint), stale: status.state === "stale" };
}

export async function semanticSearch(
    root: string,
    query: string,
    options: SemanticSearchOptions = {},
): Promise<SemanticSearchResponse> {
    if (query.trim().length === 0) throw new Error("semantic search query must not be empty");
    const config = loadSemanticConfig(root);
    const available = await queryableIndex(root);
    const runtime = await createLlamaRuntime(config.manifest, config.local);
    const vectors = await runtime.embed([`${config.manifest.queryPrefix}${query}`]);
    const queryVector = vectors[0];
    if (queryVector === undefined) throw new Error("embedding runtime returned no query vector");
    return {
        schemaVersion: 1,
        fingerprint: runtime.fingerprint,
        stale: available.stale,
        results: rankedResults(available.index, normalizeVector(queryVector), options, available.stale),
    };
}

function containingRow(rows: IndexedFunctionRow[], file: string, line: number): IndexedFunctionRow | undefined {
    return rows.filter((row) => row.file === file && row.line <= line && row.endLine >= line)
        .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line) || b.line - a.line)[0];
}

export async function semanticSimilar(
    root: string,
    file: string,
    line: number,
    options: SemanticSearchOptions = {},
): Promise<SemanticSearchResponse> {
    if (!Number.isInteger(line) || line < 1) throw new Error("--line must be a positive integer");
    const available = await queryableIndex(root);
    const normalizedFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
    const row = containingRow(available.index.rows, normalizedFile, line);
    if (row === undefined) throw new Error(`no indexed function contains ${normalizedFile}:${line}`);
    const start = row.vectorOffset * available.index.meta.dimension;
    const query = available.index.vectors.slice(start, start + available.index.meta.dimension);
    return {
        schemaVersion: 1,
        fingerprint: available.index.meta.modelFingerprint,
        stale: available.stale,
        results: rankedResults(available.index, query, options, available.stale, row.id),
    };
}
