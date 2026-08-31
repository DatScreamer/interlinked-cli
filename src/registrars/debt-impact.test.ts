import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerDebtImpactCommands } from "./debt-impact.js";

describe("registerDebtImpactCommands", () => {
    it("registers explicit manual-marker recording options", () => {
        const program = new Command();
        program.command("debt");
        registerDebtImpactCommands(program);
        const debt = program.commands.find((command) => command.name() === "debt");
        const markers = debt?.commands.find((command) => command.name() === "markers");
        expect(markers?.options.map((option) => option.long)).toEqual([
            "--root",
            "--exclude",
            "--cwd",
            "--record",
            "--reason",
            "--json",
            "--short",
            "--full",
        ]);
    });
});
