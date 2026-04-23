import { describe, expect, it } from "vitest";
import { extractBindings, findDeadImports } from "../check.js";

describe("findDeadImports", () => {
	it("returns unused binding names", () => {
		const content = `import { foo } from './bar';\nconst x = 1;`;
		expect(findDeadImports(content)).toEqual(["foo"]);
	});

	it("returns empty array when binding is used", () => {
		const content = `import { foo } from './bar';\nconsole.log(foo);`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("skips namespace imports", () => {
		const content = `import * as ns from './bar';\nconst x = 1;`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("skips side-effect imports", () => {
		const content = `import './bar';\nconst x = 1;`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("does not confuse import in string literals", () => {
		const content = `import { foo } from './bar';\nconst x = "import { bar } from './baz'";\nconsole.log(foo);`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("does not confuse identifiers starting with import", () => {
		const content = `import { Foo } from './bar';\nimportant(Foo);`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("handles shebang lines before imports", () => {
		const content = `#!/usr/bin/env node\nimport { foo } from './bar';\nconst x = 1;`;
		expect(findDeadImports(content)).toEqual(["foo"]);
	});

	it("detects used import after shebang", () => {
		const content = `#!/usr/bin/env bun\nimport { foo } from './bar';\nconsole.log(foo);`;
		expect(findDeadImports(content)).toEqual([]);
	});
});

describe("extractBindings", () => {
	it("extracts named imports", () => {
		const bindings: string[] = [];
		extractBindings(`import { foo, bar } from './baz'`, bindings);
		expect(bindings).toEqual(["foo", "bar"]);
	});

	it("extracts default imports", () => {
		const bindings: string[] = [];
		extractBindings(`import Foo from './bar'`, bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	it("strips inline type keyword", () => {
		const bindings: string[] = [];
		extractBindings(`import { type Foo, Bar } from './baz'`, bindings);
		expect(bindings).toEqual(["Foo", "Bar"]);
	});

	it("uses alias from as keyword", () => {
		const bindings: string[] = [];
		extractBindings(`import { foo as bar } from './baz'`, bindings);
		expect(bindings).toEqual(["bar"]);
	});

	it("skips comment lines", () => {
		const bindings: string[] = [];
		extractBindings(`// import { foo } from './bar'`, bindings);
		expect(bindings).toEqual([]);
	});

	it("skips side-effect imports", () => {
		const bindings: string[] = [];
		extractBindings(`import './bar'`, bindings);
		expect(bindings).toEqual([]);
	});

	it("skips namespace imports", () => {
		const bindings: string[] = [];
		extractBindings(`import * as ns from './bar'`, bindings);
		expect(bindings).toEqual([]);
	});

	it("extracts type imports", () => {
		const bindings: string[] = [];
		extractBindings(`import type { Foo } from './bar'`, bindings);
		expect(bindings).toEqual(["Foo"]);
	});
});
