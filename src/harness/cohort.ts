// ===========================================
// Cohort Manager — Track all agents for one human developer
// ===========================================

import type { AgentStatus, CohortAgent, HarnessEvent } from "./types.js";

/** Timeout before an active agent is marked as "lost" — triggers reservation release (5 minutes) */
const LOST_TIMEOUT_MS = 5 * 60 * 1000;

export class CohortManager {
	private agents: Map<string, CohortAgent> = new Map();

	/** Register a new agent joining the cohort — handles reconnections gracefully */
	agentJoined(event: HarnessEvent): CohortAgent {
		const name = event.agent_name || `${event.agent_source}-${event.session_id.slice(0, 8)}`;

		const existing = this.agents.get(name);
		if (existing) {
			// Agent reconnecting after disconnect
			existing.status = "active";
			existing.session_id = event.session_id;
			existing.last_event_at = event.timestamp;
			return existing;
		}

		const agent: CohortAgent = {
			name,
			session_id: event.session_id,
			source: event.agent_source,
			status: "active",
			joined_at: event.timestamp,
			last_event_at: event.timestamp,
			files_reserved: [],
		};

		this.agents.set(name, agent);
		return agent;
	}

	/** Mark an agent as idle (graceful disconnect) */
	agentLeft(event: HarnessEvent): void {
		const agent = this.findByEvent(event);
		if (agent) {
			agent.status = "idle";
			agent.last_event_at = event.timestamp;
		}
	}

	/** Register a subagent joining */
	subagentJoined(event: HarnessEvent): CohortAgent {
		const name =
			event.agent_name ||
			(event.tool_input?.subagent_id as string) ||
			(event.tool_input?.agent_id as string) ||
			`sub-${event.session_id.slice(0, 8)}`;

		const parentName =
			(event.tool_input?.parent_agent_name as string) ||
			(event.tool_input?.parent_agent as string);

		const agent: CohortAgent = {
			name,
			session_id: event.session_id,
			source: event.agent_source,
			status: "active",
			parent_agent: parentName,
			joined_at: event.timestamp,
			last_event_at: event.timestamp,
			files_reserved: [],
		};

		this.agents.set(name, agent);
		return agent;
	}

	/** Mark a subagent as idle */
	subagentLeft(event: HarnessEvent): void {
		const name =
			event.agent_name ||
			(event.tool_input?.subagent_id as string) ||
			(event.tool_input?.agent_id as string);
		if (name) {
			const agent = this.agents.get(name);
			if (agent) {
				agent.status = "idle";
				agent.last_event_at = event.timestamp;
			}
		}
	}

	/** Update last_event_at on any activity */
	recordActivity(event: HarnessEvent): void {
		const agent = this.findByEvent(event);
		if (agent) {
			agent.last_event_at = event.timestamp;
			if (agent.status !== "active") {
				agent.status = "active";
			}
		}
	}

	/** Track a file reservation for an agent */
	addFileReservation(agentName: string, filePath: string): void {
		const agent = this.agents.get(agentName);
		if (agent && !agent.files_reserved.includes(filePath)) {
			agent.files_reserved.push(filePath);
		}
	}

	/** Remove a file reservation for an agent */
	removeFileReservation(agentName: string, filePath: string): void {
		const agent = this.agents.get(agentName);
		if (agent) {
			agent.files_reserved = agent.files_reserved.filter((f) => f !== filePath);
		}
	}

	/** Clear all reservations for an agent */
	clearReservations(agentName: string): void {
		const agent = this.agents.get(agentName);
		if (agent) {
			agent.files_reserved = [];
		}
	}

	/** Detect agents that haven't sent events recently */
	detectLostAgents(): CohortAgent[] {
		const cutoff = Date.now() - LOST_TIMEOUT_MS;
		const lost: CohortAgent[] = [];
		for (const agent of this.agents.values()) {
			if (agent.status === "active" && new Date(agent.last_event_at).getTime() < cutoff) {
				agent.status = "lost";
				lost.push(agent);
			}
		}
		return lost;
	}

	/** Check if an agent name belongs to this cohort */
	hasAgent(name: string): boolean {
		return this.agents.has(name);
	}

	/** Get a specific agent */
	getAgent(name: string): CohortAgent | undefined {
		return this.agents.get(name);
	}

	/** Get all active agents */
	getActiveAgents(): CohortAgent[] {
		return [...this.agents.values()].filter((a) => a.status === "active");
	}

	/** Get all agents regardless of status */
	getAllAgents(): CohortAgent[] {
		return [...this.agents.values()];
	}

	/** Get agent count by status */
	getCounts(): Record<AgentStatus, number> {
		const counts: Record<AgentStatus, number> = { active: 0, idle: 0, lost: 0 };
		for (const agent of this.agents.values()) {
			counts[agent.status]++;
		}
		return counts;
	}

	/** Find agent by session ID or agent name from event */
	private findByEvent(event: HarnessEvent): CohortAgent | undefined {
		// Try by agent name first
		if (event.agent_name) {
			const byName = this.agents.get(event.agent_name);
			if (byName) return byName;
		}
		// Fall back to session ID match
		for (const agent of this.agents.values()) {
			if (agent.session_id === event.session_id) return agent;
		}
		return undefined;
	}
}
