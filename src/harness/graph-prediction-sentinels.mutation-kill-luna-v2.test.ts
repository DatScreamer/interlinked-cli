import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    parseAckSubmission,
    parseSentinelAckPath,
    parseSentinelPath,
} from "./graph-prediction-sentinels.js";

const CWD = "/repo";

describe("graph-prediction sentinel mutation boundaries", () => {
    // test-contract: boundary — the sentinel path must be exactly one session directory plus one YAML file.
    it("rejects prefix lookalikes, nested paths, and suffixes after YAML", () => {
        for (const path of [
            ".interlinked/predictions/incoming-other/s/p.yaml",
            ".interlinked/predictions/incoming/s/p.yaml/extra",
            ".interlinked/predictions/incoming/s/p.yaml.bak",
            ".interlinked/predictions/incoming/s/sub/p.yaml",
        ]) expect(parseSentinelPath(path, CWD)).toBeNull();
        expect(parseSentinelPath("", CWD)).toBeNull();
        expect(parseSentinelPath(".interlinked/predictions/incoming/s/p.yml", CWD)).toEqual({
            sessionId: "s",
            absPath: resolve(CWD, ".interlinked/predictions/incoming/s/p.yml"),
        });
    });

    // test-contract: boundary — ack paths have the same strict shape but a distinct, exact base directory.
    it("applies the strict shape to ack paths and absolute inputs", () => {
        const abs = resolve(CWD, ".interlinked/predictions/ack/session/a.yaml");
        expect(parseSentinelAckPath(abs, CWD)).toEqual({ sessionId: "session", absPath: abs });
        for (const path of [
            "",
            ".interlinked/predictions/ack/session/a.yaml/extra",
            ".interlinked/predictions/ack/session/a.yaml.bak",
            ".interlinked/predictions/ack/session/sub/a.yaml",
            ".interlinked/predictions/incoming/session/a.yaml",
            ".interlinked/predictions/ack/a.yaml",
        ]) expect(parseSentinelAckPath(path, CWD)).toBeNull();
    });

    // test-contract: boundary — only an exact top-level key and indented fields constitute an acknowledgement document.
    it("distinguishes exact ack headers and rejects lookalike headers", () => {
        expect(parseAckSubmission("graph_prediction_ack: extra\n  file: src/a.ts\n").parse_error)
            .toBe("missing `file:` field");
        expect(parseAckSubmission("graph_prediction_ack :\n  file: src/a.ts\n").parse_error)
            .toBe("missing `graph_prediction_ack:` top-level key");
        expect(parseAckSubmission("graph_prediction_ack:\nfile: src/a.ts\n").parse_error)
            .toBe("missing `file:` field");
    });

    // test-contract: boundary — YAML field and list markers require their documented whitespace boundaries.
    it("requires whitespace after field and list markers", () => {
        const noFileSpace = parseAckSubmission("graph_prediction_ack:\n  file:src/a.ts\n");
        expect(noFileSpace.file).toBe("src/a.ts");
        const noDashSpace = parseAckSubmission([
            "graph_prediction_ack:", "  file: src/a.ts", "  acknowledged_triggers:", "    -one",
        ].join("\n"));
        expect(noDashSpace.acknowledged_triggers).toEqual([]);
    });

    // test-contract: boundary — quotes are removed only when they wrap the complete scalar, preserving interior quotes.
    it("strips matching edge quotes without stripping a trailing quote alone", () => {
        expect(parseAckSubmission([
            "graph_prediction_ack:", "  file: 'src/a.ts'", "  acknowledged_triggers:",
            "    - 'one'", "    - two'",
        ].join("\n"))).toEqual({ file: "src/a.ts", acknowledged_triggers: ["one", "two"] });
    });

    // test-contract: boundary — comments may be indented and CRLF normalization must preserve parsing.
    it("ignores indented comments and strips carriage returns only at line ends", () => {
        expect(parseAckSubmission("graph_prediction_ack:\r\n  # comment\r\n  file: src/a.ts\r\n")).toEqual({
            file: "src/a.ts", acknowledged_triggers: [],
        });
    });
});
