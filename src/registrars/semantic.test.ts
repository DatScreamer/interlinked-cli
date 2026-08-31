import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSemanticCommands } from "./semantic.js";

describe("registerSemanticCommands", () => {
    it("registers the complete local semantic command group", () => {
        const program = new Command();
        registerSemanticCommands(program);
        const semantic = program.commands.find((command) => command.name() === "semantic");
        expect(semantic?.commands.map((command) => command.name())).toEqual([
            "models",
            "install",
            "index",
            "status",
            "search",
            "similar",
        ]);
    });
});
