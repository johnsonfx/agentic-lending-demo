import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "./db/client.js";
import { applications } from "./db/schema.js";
import { newApplicationState } from "./domain/types.js";
import type { ApplicationState, ChatMsg, TraceEntry } from "./domain/types.js";
import type { ChatMessage } from "./agent/modelClient.js";

/**
 * The application repository. `state` is the shape tools.ts mutates;
 * `history` is what the model sees; `msgs`/`trace` are what the UI renders.
 *
 * Two different processes write to this table now: the MCP server saves
 * `state` once per tool call (see agent/tools.ts's `withState` wrapper),
 * and the orchestrator saves `history`/`msgs`/`trace` once per turn (see
 * server/index.ts). Deliberately two separate save functions rather than
 * one — if the orchestrator's end-of-turn save also rewrote `state` from
 * its own in-memory copy, it would clobber whatever the MCP server already
 * wrote mid-turn, since the two processes no longer share memory.
 */

export interface ApplicationRecord {
  id: string;
  state: ApplicationState;
  history: ChatMessage[];
  msgs: ChatMsg[];
  trace: TraceEntry[];
}

export async function createApplication(): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(applications).values({
    id,
    createdAt: now,
    updatedAt: now,
    state: newApplicationState(),
    history: [],
    msgs: [],
    trace: [],
  });
  return id;
}

export async function getApplication(id: string): Promise<ApplicationRecord | null> {
  const row = await db.query.applications.findFirst({ where: eq(applications.id, id) });
  if (!row) return null;
  return {
    id: row.id,
    state: row.state as ApplicationState,
    history: row.history as ChatMessage[],
    msgs: row.msgs as ChatMsg[],
    trace: row.trace as TraceEntry[],
  };
}

export interface ApplicationSummary {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  state: ApplicationState;
}

/**
 * For the staff dashboard's list/queue view — every application, newest
 * first, without `history`/`msgs`/`trace`'s full JSON. `getApplication`
 * above stays the one place a full record (transcript + trace) is loaded,
 * for the detail view.
 */
export async function listApplications(): Promise<ApplicationSummary[]> {
  const rows = await db
    .select({
      id: applications.id,
      createdAt: applications.createdAt,
      updatedAt: applications.updatedAt,
      state: applications.state,
    })
    .from(applications)
    .orderBy(desc(applications.updatedAt));
  return rows.map((r) => ({ ...r, state: r.state as ApplicationState }));
}

/** Written by the MCP server, once per tool call. Never touches history/msgs/trace. */
export async function saveApplicationState(id: string, state: ApplicationState): Promise<void> {
  await db.update(applications)
    .set({ updatedAt: new Date(), state })
    .where(eq(applications.id, id));
}

/** Written by the orchestrator, once per turn. Never touches state. */
export async function saveApplicationChat(
  id: string,
  chat: { history: ChatMessage[]; msgs: ChatMsg[]; trace: TraceEntry[] }
): Promise<void> {
  await db.update(applications)
    .set({ updatedAt: new Date(), ...chat })
    .where(eq(applications.id, id));
}
