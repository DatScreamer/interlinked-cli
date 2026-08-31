import { embeddingInputPrefix } from "./function-input.js";
import type {
    EmbeddingModelManifest,
    FunctionEmbeddingChunk,
    FunctionEmbeddingInput,
    LocalEmbeddingRuntime,
} from "./types.js";

const OVERLAP_PERCENT = 10;
const WHOLE_PERCENT = 100;

interface FittingEndOptions {
    code: string;
    prefix: string;
    start: number;
    points: number[];
    maxTokens: number;
    runtime: LocalEmbeddingRuntime;
}

interface OverlapOptions {
    code: string;
    end: number;
    targetTokens: number;
    points: number[];
    runtime: LocalEmbeddingRuntime;
}

function breakpoints(code: string): number[] {
    const points = new Set<number>([0, code.length]);
    for (let index = 0; index < code.length; index++) {
        const character = code[index];
        if (character === "\n" || character === ";" || character === "}" || character === ")") {
            points.add(index + 1);
        }
    }
    return [...points].sort((a, b) => a - b);
}

function safeBoundary(code: string, index: number): number {
    if (index <= 0 || index >= code.length) return index;
    const prior = code.charCodeAt(index - 1);
    const next = code.charCodeAt(index);
    if (prior >= 0xd800 && prior <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return index - 1;
    return index;
}

async function largestFittingEnd(options: FittingEndOptions): Promise<number> {
    const { code, prefix, start, points, maxTokens, runtime } = options;
    const candidates = points.filter((point) => point > start);
    let low = 0;
    let high = candidates.length - 1;
    let answer = start;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = candidates[middle];
        if (candidate === undefined) break;
        const tokens = await runtime.countTokens(`${prefix}${code.slice(start, candidate)}`);
        if (tokens <= maxTokens) {
            answer = candidate;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    if (answer > start) return answer;
    low = start + 1;
    high = code.length;
    while (low <= high) {
        const middle = safeBoundary(code, Math.floor((low + high) / 2));
        const tokens = await runtime.countTokens(`${prefix}${code.slice(start, middle)}`);
        if (tokens <= maxTokens) {
            answer = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return answer;
}

async function overlapStart(options: OverlapOptions): Promise<number> {
    const { code, end, targetTokens, points, runtime } = options;
    const candidates = points.filter((point) => point < end).reverse();
    let selected = end;
    for (const candidate of candidates) {
        const tokens = await runtime.countTokens(code.slice(candidate, end));
        if (tokens > targetTokens) break;
        selected = candidate;
    }
    return selected;
}

function assertCompleteCoverage(chunks: FunctionEmbeddingChunk[], codeLength: number): void {
    let expected = 0;
    for (const chunk of chunks) {
        if (chunk.nonOverlapStart !== expected || chunk.nonOverlapEnd <= chunk.nonOverlapStart) {
            throw new Error("semantic chunks do not cover the function exactly once");
        }
        expected = chunk.nonOverlapEnd;
    }
    if (expected !== codeLength) throw new Error("semantic chunks do not cover the complete function");
}

export async function chunkFunctionInput(
    input: FunctionEmbeddingInput,
    manifest: EmbeddingModelManifest,
    runtime: LocalEmbeddingRuntime,
): Promise<{ chunks: FunctionEmbeddingChunk[]; modelTokens: number }> {
    const modelTokens = await runtime.countTokens(input.text);
    if (modelTokens <= manifest.maxInputTokens) {
        return {
            modelTokens,
            chunks: [{
                text: input.text,
                sourceStart: 0,
                sourceEnd: input.code.length,
                nonOverlapStart: 0,
                nonOverlapEnd: input.code.length,
                modelTokens,
                weightTokens: Math.max(1, await runtime.countTokens(input.code)),
            }],
        };
    }
    const prefix = embeddingInputPrefix(input, manifest);
    const prefixTokens = await runtime.countTokens(prefix);
    if (prefixTokens >= manifest.maxInputTokens) {
        throw new Error("function embedding prefix exhausts the model context");
    }
    const points = breakpoints(input.code);
    const codeBudget = manifest.maxInputTokens - prefixTokens;
    const overlapBudget = Math.max(1, Math.floor(codeBudget * OVERLAP_PERCENT / WHOLE_PERCENT));
    const chunks: FunctionEmbeddingChunk[] = [];
    let covered = 0;
    let start = 0;
    while (covered < input.code.length) {
        const end = await largestFittingEnd({
            code: input.code,
            prefix,
            start,
            points,
            maxTokens: manifest.maxInputTokens,
            runtime,
        });
        if (end <= covered) throw new Error("a function token cannot fit in the model context");
        const text = `${prefix}${input.code.slice(start, end)}`;
        chunks.push({
            text,
            sourceStart: start,
            sourceEnd: end,
            nonOverlapStart: covered,
            nonOverlapEnd: end,
            modelTokens: await runtime.countTokens(text),
            weightTokens: Math.max(1, await runtime.countTokens(input.code.slice(covered, end))),
        });
        covered = end;
        if (covered < input.code.length) {
            start = await overlapStart({ code: input.code, end: covered, targetTokens: overlapBudget, points, runtime });
        }
    }
    assertCompleteCoverage(chunks, input.code.length);
    return { chunks, modelTokens };
}
