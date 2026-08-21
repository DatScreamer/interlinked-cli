import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
    checkRegistryParity,
    extractKeys,
    loadRegistryParityConfig,
} from "./registry-parity.js";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function configRoot(value: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "registry-parity-test-"));
    roots.push(root);
    mkdirSync(join(root, ".interlinked"), { recursive: true });
    writeFileSync(
        join(root, ".interlinked", "registry-parity.json"),
        JSON.stringify(value),
        "utf-8",
    );
    return root;
}

function validPair() {
    return {
        name: "pair",
        left: { file: "left.ts", key_re: 'id: "([^"]+)"' },
        right: { file: "right.ts", key_re: 'id: "([^"]+)"' },
    };
}

describe("registry parity mutation contracts", () => {
    // test-contract: non-array pairs configuration is rejected with its validation error.
    it("rejects a non-array pairs value", () => {
        const root = configRoot({ pairs: {} });
        expect(() => loadRegistryParityConfig(root)).toThrow(
            "registry-parity.pairs must be an array",
        );
    });

    // test-contract: malformed pair fields are rejected instead of accepted as valid configuration.
    it("rejects non-object and non-string pair data", () => {
        const root = configRoot({ pairs: [null] });
        expect(() => loadRegistryParityConfig(root)).toThrow("pairs[0] must be an object");

        const invalidName = configRoot({
            pairs: [{ ...validPair(), name: 7 }],
        });
        expect(() => loadRegistryParityConfig(invalidName)).toThrow(
            "pairs[0].name must be a string",
        );
    });

    // test-contract: optional allowlists must be arrays containing only strings.
    it("rejects malformed allowlists", () => {
        const invalidArray = configRoot({
            pairs: [{ ...validPair(), left_only_allowed: {} }],
        });
        expect(() => loadRegistryParityConfig(invalidArray)).toThrow(
            "pairs[0].left_only_allowed must be an array",
        );

        const invalidEntry = configRoot({
            pairs: [{ ...validPair(), right_only_allowed: ["ok", 3] }],
        });
        expect(() => loadRegistryParityConfig(invalidEntry)).toThrow(
            "pairs[0].right_only_allowed entries must be strings",
        );
    });

    // test-contract: only matches with capture group one become extracted registry IDs.
    it("extracts capture-group IDs and ignores matches without capture group one", () => {
        expect(extractKeys('id: "alpha"; plain', 'id: "([^"]+)"|plain')).toEqual(
            new Set(["alpha"]),
        );
    });

    // test-contract: a missing left source produces a missing-file finding without reading the right source.
    it("reports a missing left file", () => {
        const root = configRoot({ pairs: [validPair()] });
        writeFileSync(join(root, "right.ts"), 'id: "alpha"', "utf-8");

        expect(checkRegistryParity({ pairs: [validPair()] }, root)).toEqual([
            {
                pair: "pair",
                kind: "missing-file",
                id: "left.ts",
                source_file: "left.ts",
                target_file: "right.ts",
                message: "Left file missing: left.ts",
            },
        ]);
    });

    // test-contract: null, primitive, and array JSON roots are rejected as configuration objects.
    it("rejects non-object configuration roots", () => {
        for (const value of [null, 3, [], "config"]) {
            const root = configRoot(value);
            expect(() => loadRegistryParityConfig(root)).toThrow(
                "registry-parity config must be an object",
            );
        }
    });
});
