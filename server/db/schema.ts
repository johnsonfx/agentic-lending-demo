import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * One table, JSON columns — there's no natural relational structure to
 * `bureau`/`offer`/`checks` worth normalizing yet. Saved once per turn, when
 * the agent loop's SSE stream ends, not per-event.
 */
export const applications = sqliteTable("applications", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  state: text("state", { mode: "json" }).notNull(),
  history: text("history", { mode: "json" }).notNull(),
  msgs: text("msgs", { mode: "json" }).notNull(),
  trace: text("trace", { mode: "json" }).notNull(),
});
