import { kvLine } from "../lib/formatter.js";
import type {
	FramedSocketStatus,
	HarnessProtocolStatus,
} from "./harness-status-helpers.js";

/** Protocol sub-lines for the human-readable status report (caller guards non-null). */
export function protocolStatusLines(protocolStatus: HarnessProtocolStatus): string[] {
	const lines = [kvLine("Protocol", protocolStatus.protocol)];
	if (protocolStatus.raw_socket_path) {
		lines.push(kvLine("Raw socket", protocolStatus.raw_socket_path));
	}
	if (protocolStatus.framed_socket_path) {
		lines.push(kvLine("Framed socket", protocolStatus.framed_socket_path));
	}
	if (protocolStatus.last_raw_event_at) {
		lines.push(kvLine("Last raw event", protocolStatus.last_raw_event_at));
	}
	if (protocolStatus.last_framed_event_at) {
		lines.push(kvLine("Last framed event", protocolStatus.last_framed_event_at));
	}
	lines.push(
		kvLine(
			"Framed errors",
			`${protocolStatus.framed_error_count} errors, ${protocolStatus.framed_timeout_count} timeouts`,
		),
	);
	return lines;
}

/** One line per framed socket (health, or its error / "unknown" fallback). */
export function framedSocketLines(framedSockets: FramedSocketStatus[]): string[] {
	return framedSockets.map((framed) => {
		const health = framed.health
			? `${framed.health.status} (${framed.health.protocol_version})`
			: framed.health_error || "unknown";
		return kvLine(`Framed ${framed.session_id}`, `${health} — ${framed.socket_path}`);
	});
}
