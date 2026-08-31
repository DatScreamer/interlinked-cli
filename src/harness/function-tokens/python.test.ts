import { describe, expect, it } from "vitest";
import { computePythonFunctionTokens } from "./python.js";

function entries(source: string) {
    const result = computePythonFunctionTokens(source, "src/example.py");
    expect(result).not.toBeNull();
    return result ?? [];
}

describe("interlinked-code-v1 Python adapter", () => {
    it("extracts decorated, nested, method, constructor, and lambda implementations", () => {
        const result = entries(`
@decorator
def outer(value: str) -> str:
    def inner():
        return value
    callback = lambda item: item + 1
    return inner()

class Service:
    def __init__(self):
        self.value = 1

    def read(self):
        return self.value
`);
        expect(result.map((entry) => [entry.qualifiedName, entry.declarationKind])).toEqual([
            ["outer", "function"],
            ["outer.inner", "closure"],
            ["outer.(callback)", "lambda"],
            ["Service.__init__", "constructor"],
            ["Service.read", "method"],
        ]);
        expect(result[0]?.startOffset).toBe(1);
    });

    it("ignores trivia and treats a string literal as one canonical token", () => {
        const compact = entries("def f():\n    return 'many words'\n")[0];
        const commented = entries("def f( ):\n    # ignored\n    return 'many words'\n")[0];
        expect(compact?.canonicalTokens).toBe(commented?.canonicalTokens);
        expect(compact?.canonicalTokens).toBe(7);
    });

    it("returns UTF-16 offsets for Unicode before and inside a function", () => {
        const source = "title = '😀'\n\ndef café(value='😀'):\n    return value\n";
        const entry = entries(source)[0];
        expect(source.slice(entry?.startOffset, entry?.endOffset)).toContain("def café");
    });

    it("fails open on malformed source", () => {
        expect(computePythonFunctionTokens("def broken(:\n", "broken.py")).toBeNull();
    });
});
