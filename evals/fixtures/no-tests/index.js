import { greet, slugify } from "./lib/util.js";

const [command, ...rest] = process.argv.slice(2);

if (command === "greet") {
	console.log(greet(rest[0] ?? "world"));
} else if (command === "slug") {
	console.log(slugify(rest.join(" ")));
} else {
	console.log("usage: node index.js greet <name> | slug <words...>");
}
