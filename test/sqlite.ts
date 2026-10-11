// A D1Database stand-in over Node's built-in SQLite, with the real migrations
// applied, so the import/cleanup/stats SQL is exercised for real in unit tests.
// (D1 is SQLite too; foreign keys are enforced there by default, so here as well.)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/worker/types";

type Bind = string | number | bigint | null | Uint8Array;

function normalize(values: unknown[]): Bind[] {
  return values.map((v) => {
    if (v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    return v as Bind;
  });
}

function plain<T>(row: unknown): T {
  return row ? ({ ...(row as object) } as T) : (row as T);
}

/**
 * D1's SQL limits, far below SQLite's defaults (measured on production D1,
 * 2026-10-06): a query that breaks one passes here only if these are set.
 */
export const D1_LIMITS = {
  compoundSelect: 5, // terms in one UNION / UNION ALL chain (SQLite: 500)
  exprDepth: 100, // SQLite: 1000
  likePatternLength: 50, // bytes (SQLite: 50,000)
  variableNumber: 100, // bound parameters (SQLite: 32,766)
  sqlLength: 100_000, // bytes per statement (SQLite: 1,000,000,000)
};

export function createD1(): { db: D1Database; raw: DatabaseSync; executed: string[] } {
  const raw = new DatabaseSync(":memory:", { limits: D1_LIMITS });
  raw.exec("PRAGMA foreign_keys = ON");
  // Every statement run through the binding, in order: tests check what a job reads.
  const executed: string[] = [];

  const execute = (sql: string, binds: Bind[]) => {
    executed.push(sql);
    const stmt = raw.prepare(sql);
    const rows = stmt.all(...binds).map((r) => plain<Record<string, unknown>>(r));
    const changes = Number((raw.prepare("SELECT changes() AS c").get() as { c: number }).c);
    return { rows, changes };
  };

  class Statement {
    constructor(
      readonly sql: string,
      readonly binds: Bind[] = [],
    ) {}
    bind(...values: unknown[]) {
      return new Statement(this.sql, normalize(values));
    }
    async all<T>() {
      const { rows, changes } = execute(this.sql, this.binds);
      return { results: rows as T[], success: true, meta: { changes } };
    }
    async first<T>(col?: string) {
      const { rows } = execute(this.sql, this.binds);
      const row = rows[0] ?? null;
      if (row && col) return (row[col] ?? null) as T;
      return row as T | null;
    }
    async run() {
      const { rows, changes } = execute(this.sql, this.binds);
      return { results: rows, success: true, meta: { changes } };
    }
    async raw() {
      const { rows } = execute(this.sql, this.binds);
      return rows.map((r) => Object.values(r));
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      raw.exec("BEGIN");
      try {
        const out = statements.map((s) => {
          const { rows, changes } = execute(s.sql, s.binds);
          return { results: rows, success: true, meta: { changes } };
        });
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(sql: string) {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;

  return { db, raw, executed };
}

/** Fresh database with every migration applied, wrapped in an Env. */
export function testEnv(): { env: Env; raw: DatabaseSync; executed: string[] } {
  const { db, raw, executed } = createD1();
  const dir = join(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(dir, file), "utf8"));
  }
  const env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    SPOTIFY_CLIENT_ID: "test",
    SPOTIFY_CLIENT_SECRET: "test",
    API_KEY: "test-key",
    STATE_SECRET: "test-secret",
    SPOTIFY_REDIRECT_URI: "http://127.0.0.1:8787/auth/callback",
    ENVIRONMENT: "test",
    API_LOG_RETENTION_DAYS: "30",
    APP_NAME: "Encore",
    APP_URL: "http://127.0.0.1:8787",
    EMAIL_FROM: "encore@example.com",
  } satisfies Env;
  return { env, raw, executed };
}
