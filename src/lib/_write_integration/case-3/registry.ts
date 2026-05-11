import { randomUUID } from "node:crypto";
export function register(name: string): string {
	return name + ":" + randomUUID();
}
