import type { HarnessEvent } from "./types.js";

/** Shared optional attribution projection. Keeping the branches here prevents
 * every observability writer from independently growing its hot-path score. */
export function eventAttributionFields(event: HarnessEvent): {
    subagent_id?: string;
    model?: string;
    parent_agent?: string;
} {
    const fields: { subagent_id?: string; model?: string; parent_agent?: string } = {};
    if (event.subagent_id) fields.subagent_id = event.subagent_id;
    if (event.model) fields.model = event.model;
    if (event.parent_agent) fields.parent_agent = event.parent_agent;
    return fields;
}
