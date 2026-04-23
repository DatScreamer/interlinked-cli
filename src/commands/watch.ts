// ===========================================
// Watch Command — Monitor server for pending work
// ===========================================
// Polls the server for unread messages, pending tasks, and active agents.
// Displays a live dashboard that refreshes automatically.
// Detects changes between polls and prints notifications when new work arrives.
// Foundation for "no more bash sleep" — CLI monitors, agents activate on work.

import { getClient } from "../lib/api-client.js";
import { c } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

const MS_PER_SECOND = 1000;

// ===========================================
// Types
// ===========================================

interface TaskItem {
	id: number;
	title: string;
	status: string;
	priority: string;
	assignee: string | null;
}

interface AgentItem {
	name: string;
	role: string | null;
	status: string;
	last_active: string | null;
	current_task: string | null; // Task title the agent is working on
}

interface WorkStatus {
	timestamp: string;
	server: { reachable: boolean; error?: string };
	messages: {
		has_unread: boolean;
		unread_count: number;
		oldest_unread_at: string | null;
	} | null;
	tasks: {
		pending: number;
		in_progress: number;
		blocked: number;
		unassigned: number;
		items: TaskItem[];
	} | null;
	agents: {
		total: number;
		online: number;
		idle: number;
		items: AgentItem[];
	} | null;
	notifications: string[];
}

// ===========================================
// Data Fetching
// ===========================================

async function fetchWorkStatus(previous: WorkStatus | null): Promise<WorkStatus> {
	const client = getClient();
	const timestamp = new Date().toISOString();

	if (!client.isAuthenticated() && !client.isLocalDevServer()) {
		return {
			timestamp,
			server: { reachable: false, error: "Not authenticated. Run: interlinked login" },
			messages: null,
			tasks: null,
			agents: null,
			notifications: [],
		};
	}

	// Fetch all data in parallel
	const [msgResult, taskResult, agentResult] = await Promise.allSettled([
		client.callTool<{
			has_unread: boolean;
			unread_count: number;
			oldest_unread_at: string | null;
		}>("has_unread_messages", {}),
		client.callTool<{
			tasks: Array<{
				id: number;
				title: string;
				status: string;
				priority: string;
				assignee_name: string | null;
			}>;
			count: number;
		}>("list_tasks", { limit: 50 }),
		client.callTool<{
			agents: Array<{
				name: string;
				role: string | null;
				status: string;
				last_active_ts: string | null;
			}>;
		}>("list_agents", {}),
	]);

	const messages =
		msgResult.status === "fulfilled"
			? {
					has_unread: msgResult.value.has_unread,
					unread_count: msgResult.value.unread_count,
					oldest_unread_at: msgResult.value.oldest_unread_at,
				}
			: null;

	let tasks: WorkStatus["tasks"] = null;
	const taskAssignees = new Map<string, string>(); // agent → task title
	if (taskResult.status === "fulfilled") {
		const all = taskResult.value.tasks || [];
		const active = all.filter((t) => t.status !== "completed" && t.status !== "cancelled");
		const unassigned = active.filter((t) => t.status === "pending" && !t.assignee_name);

		// Build assignee → task map for agent cross-reference
		for (const t of all.filter((t) => t.status === "in_progress" && t.assignee_name)) {
			taskAssignees.set(t.assignee_name!, t.title);
		}

		tasks = {
			pending: all.filter((t) => t.status === "pending").length,
			in_progress: all.filter((t) => t.status === "in_progress").length,
			blocked: all.filter((t) => t.status === "blocked").length,
			unassigned: unassigned.length,
			items: active.map((t) => ({
				id: t.id,
				title: t.title,
				status: t.status,
				priority: t.priority,
				assignee: t.assignee_name,
			})),
		};
	}

	let agents: WorkStatus["agents"] = null;
	if (agentResult.status === "fulfilled") {
		const all = agentResult.value.agents || [];
		const active = all.filter(
			(a) => a.status === "active" && a.name !== "System" && a.name !== "HumanOverseer",
		);
		const items: AgentItem[] = active.map((a) => ({
			name: a.name,
			role: a.role,
			status: a.status,
			last_active: a.last_active_ts,
			current_task: taskAssignees.get(a.name) || null,
		}));
		const idle = items.filter((a) => !a.current_task).length;
		agents = {
			total: active.length,
			online: active.filter((a) => a.last_active_ts !== null).length,
			idle,
			items,
		};
	}

	// Detect changes from previous poll
	const notifications = detectChanges(previous, { messages, tasks, agents });

	return {
		timestamp,
		server: { reachable: true },
		messages,
		tasks,
		agents,
		notifications,
	};
}

// ===========================================
// Change Detection
// ===========================================

function detectChanges(
	prev: WorkStatus | null,
	curr: {
		messages: WorkStatus["messages"];
		tasks: WorkStatus["tasks"];
		agents: WorkStatus["agents"];
	},
): string[] {
	if (!prev) return [];
	const notes: string[] = [];

	// New unread messages
	if (curr.messages && prev.messages) {
		const delta = curr.messages.unread_count - prev.messages.unread_count;
		if (delta > 0) {
			notes.push(`${delta} new unread message${delta > 1 ? "s" : ""}`);
		}
	}

	// New tasks appeared
	if (curr.tasks && prev.tasks) {
		const prevIds = new Set(prev.tasks.items.map((t) => t.id));
		const newTasks = curr.tasks.items.filter((t) => !prevIds.has(t.id));
		for (const t of newTasks) {
			notes.push(`New task #${t.id}: ${truncate(t.title, 40)}`);
		}

		// Tasks became unassigned (assignee removed or new unassigned task)
		if (curr.tasks.unassigned > (prev.tasks.unassigned || 0)) {
			const delta = curr.tasks.unassigned - (prev.tasks.unassigned || 0);
			notes.push(`${delta} task${delta > 1 ? "s" : ""} waiting for assignment`);
		}
	}

	// Agent count changes
	if (curr.agents && prev.agents) {
		if (curr.agents.total > prev.agents.total) {
			const delta = curr.agents.total - prev.agents.total;
			notes.push(`${delta} new agent${delta > 1 ? "s" : ""} came online`);
		}
		if (curr.agents.total < prev.agents.total) {
			const delta = prev.agents.total - curr.agents.total;
			notes.push(`${delta} agent${delta > 1 ? "s" : ""} went offline`);
		}
	}

	return notes;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.substring(0, max - 3)}...` : s;
}

// ===========================================
// Renderers
// ===========================================

function renderShort(data: WorkStatus): string {
	if (!data.server.reachable) return c.red(`offline: ${data.server.error || "unreachable"}`);

	const parts: string[] = [];

	if (data.messages) {
		parts.push(
			data.messages.has_unread
				? c.yellow(`${data.messages.unread_count} unread`)
				: c.dim("0 unread"),
		);
	}

	if (data.tasks) {
		const workCount = data.tasks.pending + data.tasks.in_progress;
		parts.push(workCount > 0 ? c.green(`${workCount} active tasks`) : c.dim("0 tasks"));
		if (data.tasks.unassigned > 0) {
			parts.push(c.yellow(`${data.tasks.unassigned} unassigned`));
		}
	}

	if (data.agents) {
		const idleLabel = data.agents.idle > 0 ? c.yellow(` (${data.agents.idle} idle)`) : "";
		parts.push(c.dim(`${data.agents.total} agents`) + idleLabel);
	}

	return parts.join(" | ");
}

function renderNormal(data: WorkStatus): string {
	const lines: string[] = [];

	lines.push(c.bold("Interlinked Watch"));
	lines.push(c.dim(`  ${data.timestamp}`));

	// Notifications (if any)
	if (data.notifications.length > 0) {
		lines.push("");
		lines.push(c.bold(c.yellow("  Notifications")));
		for (const note of data.notifications) {
			lines.push(`    ${c.yellow(">")} ${note}`);
		}
	}

	lines.push("");

	if (!data.server.reachable) {
		lines.push(c.red(`  Server: ${data.server.error || "unreachable"}`));
		return lines.join("\n");
	}

	// Messages section
	lines.push(c.bold("  Messages"));
	if (data.messages) {
		if (data.messages.has_unread) {
			lines.push(c.yellow(`    ${data.messages.unread_count} unread messages`));
			if (data.messages.oldest_unread_at) {
				lines.push(c.dim(`    oldest: ${data.messages.oldest_unread_at}`));
			}
		} else {
			lines.push(c.dim("    No unread messages"));
		}
	} else {
		lines.push(c.dim("    (unavailable)"));
	}
	lines.push("");

	// Tasks section
	lines.push(c.bold("  Work Queue"));
	if (data.tasks) {
		const { pending, in_progress, blocked, unassigned, items } = data.tasks;
		if (pending + in_progress + blocked === 0) {
			lines.push(c.dim("    No active tasks"));
		} else {
			const summary: string[] = [];
			if (pending > 0) summary.push(c.yellow(`${pending} pending`));
			if (in_progress > 0) summary.push(c.green(`${in_progress} in progress`));
			if (blocked > 0) summary.push(c.red(`${blocked} blocked`));
			lines.push(`    ${summary.join(" | ")}`);
			if (unassigned > 0) {
				lines.push(`    ${c.yellow(`${unassigned} unassigned — needs pickup`)}`);
			}
			lines.push("");

			// Show tasks, unassigned first
			const sorted = [...items].sort((a, b) => {
				// Unassigned pending first
				if (!a.assignee && a.status === "pending" && (b.assignee || b.status !== "pending"))
					return -1;
				if (!b.assignee && b.status === "pending" && (a.assignee || a.status !== "pending"))
					return 1;
				return 0;
			});

			for (const task of sorted.slice(0, 12)) {
				const badge = taskBadge(task.status);
				const assignee = task.assignee
					? c.dim(` -> ${task.assignee}`)
					: c.yellow(" (unassigned)");
				const title = truncate(task.title, 45);
				lines.push(`    ${badge} #${task.id} ${title}${assignee}`);
			}
			if (items.length > 12) {
				lines.push(c.dim(`    ... and ${items.length - 12} more`));
			}
		}
	} else {
		lines.push(c.dim("    (unavailable)"));
	}
	lines.push("");

	// Agents section
	lines.push(c.bold("  Agents"));
	if (data.agents) {
		if (data.agents.total === 0) {
			lines.push(c.dim("    No active agents"));
		} else {
			const summary = `${data.agents.total} total, ${data.agents.total - data.agents.idle} working, ${data.agents.idle} idle`;
			lines.push(c.dim(`    ${summary}`));
			lines.push("");

			for (const agent of data.agents.items) {
				const role = agent.role ? c.dim(` (${agent.role})`) : "";
				const dot = agent.current_task ? c.green("●") : c.yellow("○");
				const work = agent.current_task
					? c.dim(` -> ${truncate(agent.current_task, 35)}`)
					: c.dim(" idle");
				lines.push(`    ${dot} ${agent.name}${role}${work}`);
			}
		}
	} else {
		lines.push(c.dim("    (unavailable)"));
	}

	return lines.join("\n");
}

function taskBadge(status: string): string {
	switch (status) {
		case "pending":
			return c.yellow("○");
		case "in_progress":
			return c.green("●");
		case "blocked":
			return c.red("✕");
		default:
			return c.dim("·");
	}
}

// ===========================================
// Command Entry Point
// ===========================================

const MIN_INTERVAL_SEC = 2;
const DEFAULT_INTERVAL_SEC = 10;

export async function watchCommand(opts: {
	json?: boolean;
	short?: boolean;
	full?: boolean;
	interval?: string;
}): Promise<void> {
	const mode = getOutputMode(opts);

	// Parse interval
	const rawInterval = opts.interval;
	let intervalSec = DEFAULT_INTERVAL_SEC;
	if (rawInterval !== undefined) {
		const parsed = Number.parseInt(rawInterval, 10);
		if (!Number.isNaN(parsed) && parsed >= MIN_INTERVAL_SEC) {
			intervalSec = parsed;
		}
	}

	let previousStatus: WorkStatus | null = null;

	const runOnce = async () => {
		try {
			const data = await fetchWorkStatus(previousStatus);
			output(mode, data, {
				json: () => data,
				short: () => renderShort(data),
				normal: () => renderNormal(data),
			});
			previousStatus = data;
		} catch (err) {
			outputError(mode, (err as Error).message);
		}
	};

	// Initial render
	await runOnce();

	// Watch loop
	if (mode !== "json") {
		console.log(c.dim(`\nRefreshing every ${intervalSec}s... (Ctrl+C to stop)\n`));
	}

	const tick = async () => {
		if (mode !== "json") {
			process.stdout.write("\x1B[2J\x1B[0f"); // Clear screen
		}
		await runOnce();
		if (mode !== "json") {
			console.log(c.dim(`\nRefreshing every ${intervalSec}s... (Ctrl+C to stop)`));
		}
		setTimeout(tick, intervalSec * MS_PER_SECOND);
	};

	setTimeout(tick, intervalSec * MS_PER_SECOND);
}
