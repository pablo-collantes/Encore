#!/usr/bin/env node
// Upload a Spotify privacy export from the command line: the same thing the
// dashboard's Import page does in the browser, using the same parser
// (src/shared/exportFormats.ts) and the same /api/imports endpoints.
//
// Accepts the zip exactly as Spotify sends it, or the JSON files inside it:
//   * Extended streaming history  (Streaming_History_Audio_*.json, lifetime)
//   * Account data                (StreamingHistory_music_*.json, last year)
// Overlaps between exports, and with live collection, are de-duplicated by the
// Worker; re-running is safe.
//
// Usage:
//   node scripts/import-history.mjs --url https://encore.example.com \
//        --key "$API_KEY" my_spotify_data.zip
//
// Needs Node 23.6+ (imports the TypeScript parser directly).

import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { isCandidateExportPath, parseExportFile } from "../src/shared/exportFormats.ts";

const argv = process.argv.slice(2);
const takeFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};

const baseUrl = (takeFlag("url") ?? process.env.WORKER_URL ?? "").replace(/\/+$/, "");
const apiKey = takeFlag("key") ?? process.env.API_KEY;
const chunkSize = Math.min(Number(takeFlag("chunk") ?? 4000), 5000);
const files = argv.filter((a) => !a.startsWith("--"));

if (!baseUrl || !apiKey || files.length === 0) {
  console.error(`usage: node scripts/import-history.mjs --url <site> --key <API_KEY> <export.zip | file.json ...>

  --url    site URL          (or WORKER_URL env var)
  --key    API_KEY secret    (or API_KEY env var)
  --chunk  rows per request  (default 4000, max 5000)`);
  process.exit(1);
}

async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (attempt < 3 && (res.status >= 500 || res.status === 429)) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

// 1. Read and parse.
const parsed = [];
for (const file of files) {
  if (/\.zip$/i.test(file)) {
    const entries = unzipSync(new Uint8Array(await readFile(file)), { filter: (f) => isCandidateExportPath(f.name) });
    for (const [path, data] of Object.entries(entries)) parsed.push(parseExportFile(path, new TextDecoder().decode(data)));
  } else {
    parsed.push(parseExportFile(file, await readFile(file, "utf8")));
  }
}
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");
for (const f of parsed) {
  const what = f.kind === "other" ? `skipped (${f.note})` : `${f.kind}: ${f.rows.length} listens, ${day(f.firstTs)} → ${day(f.lastTs)}`;
  console.log(`  ${f.name}: ${what}${f.dropped ? `, ${f.dropped} entries dropped` : ""}`);
}
const history = parsed.filter((f) => f.kind !== "other" && f.rows.length > 0);
const rows = history.flatMap((f) => f.rows).sort((a, b) => a.ts - b.ts);
if (rows.length === 0) {
  console.error("No listening history found in those files.");
  process.exit(1);
}

// 2. Upload.
const { id } = await api("POST", "/api/imports", { files: history.map((f) => ({ name: f.name, kind: f.kind, rows: f.rows.length })) });
console.log(`→ import ${id}: ${rows.length} listens in chunks of ${chunkSize}`);
let inserted = 0;
const started = Date.now();
for (let i = 0; i < rows.length; i += chunkSize) {
  const res = await api("POST", `/api/imports/${id}/rows`, { rows: rows.slice(i, i + chunkSize) });
  inserted += res.inserted;
  process.stdout.write(`\r  ${Math.min(i + chunkSize, rows.length)}/${rows.length} sent, ${inserted} new`);
}
process.stdout.write("\n");

// 3. Clean up: resolve names, mark duplicates across sources.
const done = await api("POST", `/api/imports/${id}/finish`);
console.log(
  `✓ ${inserted} new listens in ${((Date.now() - started) / 1000).toFixed(1)}s; ` +
    `${done.batch.duplicates} of this import's rows duplicate data already there; ` +
    `cleanup resolved ${done.cleanup.resolvedByName} by name in ${done.cleanup.ms} ms`,
);
