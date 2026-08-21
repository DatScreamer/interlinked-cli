import { describe, expect, it } from "vitest";
import { checkIntrovertedTest } from "./introverted-test.js";

const cartImport = 'import { price } from "./cart.js";';

function findings(content: string, filePath = "cart.test.ts") {

    return checkIntrovertedTest(content, filePath);
}

describe("checkIntrovertedTest mutation contracts", () => {
    // test-contract: boundary — a supported companion test path must derive the companion basename
    it("recognizes the companion module for a standard test filename", () => {
        const content = `${cartImport}\nit("x", () => { expect(3).toBe(3); });`;

        expect(findings(content)).toHaveLength(1);
    });

    // test-contract: boundary — non-test and non-JavaScript paths are outside this check's contract
    it("does not inspect non-test or unsupported file extensions", () => {
        const content = `${cartImport}\nit("x", () => { expect(3).toBe(3); });`;

        expect(findings(content, "cart.ts")).toHaveLength(0);
        expect(findings(content, "cart.test.txt")).toHaveLength(0);
    });

    // test-contract: invariant — only vi.mock and jest.mock calls mark modules as mocked
    it("keeps ordinary member calls from being mistaken for mock declarations", () => {
        const content = `${cartImport}
const dep = { mock: () => 3 };
it("x", () => { expect(dep.mock()).toBe(3); });`;

        expect(findings(content)).toHaveLength(1);
    });

    // test-contract: invariant — a direct non-mocked companion call is observable SUT use
    it("accepts a direct companion call as an extroverted assertion subject", () => {
        const content = `${cartImport}\nit("x", () => { expect(price()).toBe(3); });`;

        expect(findings(content)).toHaveLength(0);
    });

    // test-contract: invariant — namespace member calls are also observable companion use
    it("accepts a namespace companion call as SUT use", () => {
        const content = `import * as cart from "./cart.js";
it("x", () => { expect(cart.price()).toBe(3); });`;

        expect(findings(content)).toHaveLength(0);
    });

    // test-contract: invariant — provenance flows through a local binding created from the SUT
    it("retains SUT provenance through a simple local binding", () => {
        const content = `${cartImport}
it("x", () => {
    const current = price();
    expect(current).toBe(3);
});`;

        expect(findings(content)).toHaveLength(0);
    });

    // test-contract: invariant — destructured values inherit provenance from their SUT-producing initializer
    it("retains SUT provenance through object and array destructuring", () => {
        const content = `${cartImport}
it("object", () => {
    const { amount } = price();
    expect(amount).toBe(3);
});
it("array", () => {
    const [amount] = price();
    expect(amount).toBe(3);
});`;

        expect(findings(content)).toHaveLength(0);
    });

    // test-contract: boundary — assertion APIs without a subject do not constitute introverted assertions
    it("ignores assertion calls that have no arguments", () => {
        const content = `${cartImport}\nit("x", () => { expect(); });`;

        expect(findings(content)).toHaveLength(0);
    });

    // test-contract: invariant — a file-local factory that calls the companion makes its returned assertion extroverted
    it("follows companion use through a file-local helper", () => {
        const content = `${cartImport}
const current = () => price();
it("x", () => { expect(current()).toBe(3); });`;

        expect(findings(content)).toHaveLength(0);
    });

    // test-contract: invariant — primitive assertion subjects are classified as non-SUT values
    it("flags literal-only assertions even when they include several primitive kinds", () => {
        const content = `${cartImport}
it("strings", () => { expect("cart").toBe("cart"); });
it("numbers", () => { expect(7).toBe(7); });
it("booleans", () => { expect(true).toBe(true); });
it("null", () => { expect(null).toBe(null); });
it("regex", () => { expect(/cart/).toBeInstanceOf(RegExp); });
it("template", () => { expect(\`cart\`).toBe("cart"); });`;

        expect(findings(content)).toHaveLength(6);
    });
});
