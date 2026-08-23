import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import * as schema from "./schema.js";

const DB_PATH = path.resolve(process.cwd(), "data/app.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

// Run automatically on startup so a fresh checkout just works — no manual
// migration step for a database this size.
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");
migrate(db, { migrationsFolder });
