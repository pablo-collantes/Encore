#!/usr/bin/env node
// Bootstrap (or recover) an Encore admin account.
//
//   node scripts/invite-admin.mjs <email> [name]                    # local D1 (vite dev)
//   node scripts/invite-admin.mjs <email> [name] --remote           # production D1, prints the link
//   node scripts/invite-admin.mjs <email> [name] --remote --email   # ...and emails it instead of printing
//   node scripts/invite-admin.mjs <email> [name] --remote --base <url>
//
// Never takes a password: the account is upserted as an enabled admin and you
// get a one-time link to set one in the browser, so no password ever sits in
// shell history or a SQL file.
//   - new / never-activated account -> 7-day invite: <base>/set-password#<token>
//   - already activated             -> 1-hour reset: <base>/reset-password#<token>
//     (the existing password keeps working until the link is used)
// Only the token's SHA-256 goes into D1. With --email the link goes to <email>
// from FROM below (keep it equal to EMAIL_FROM in wrangler.jsonc) and is not printed.
// Local use needs the migrations applied first: npm run db:migrate:local
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "encore";
const FROM = "encore@example.com";
const APP = "Encore";
const INVITE_TTL_MS = 7 * 86_400_000;
const RESET_TTL_MS = 3_600_000;

function usage() {
  console.error("usage: node scripts/invite-admin.mjs <email> [name] [--remote] [--email] [--base <url>]");
  process.exit(2);
}

const positional = [];
let remote = false;
let email = false;
let base = null;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--remote") remote = true;
    else if (a === "--local") remote = false;
    else if (a === "--email") email = true;
    else if (a === "--base") base = argv[++i] ?? usage();
    else if (a.startsWith("--base=")) base = a.slice(7);
    else if (a.startsWith("--")) usage();
    else positional.push(a);
  }
}
const to = (positional[0] ?? "").trim().toLowerCase();
const name = (positional[1] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) || null;
if (!/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(to) || to.length > 254 || positional.length > 2) usage();
base = (base ?? (remote ? "https://encore.example.com" : "http://127.0.0.1:8787")).replace(/\/+$/, "");
try {
  new URL(base);
} catch {
  console.error(`--base is not a URL: ${base}`);
  process.exit(2);
}

const where = remote ? "--remote" : "--local";
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const wrangler = (args, capture = false) =>
  execFileSync("npx", ["wrangler", ...args], { cwd: ROOT, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });

// 1. Does the account exist, and has it set a password yet?
const out = wrangler(
  ["d1", "execute", DB_NAME, where, "--json", "--command", `SELECT id, CASE WHEN password_hash = '' THEN 0 ELSE 1 END AS activated FROM users WHERE email = ${sq(to)}`],
  true,
);
const rows = JSON.parse(out.slice(out.indexOf("[")))[0]?.results ?? [];
const activated = rows[0]?.activated === 1;
const kind = activated ? "reset" : "invite";

// 2. Upsert the admin, retire older unused links of this kind, store the new token's hash.
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const now = Date.now();
const expires = now + (kind === "invite" ? INVITE_TTL_MS : RESET_TTL_MS);
const sql = `
INSERT INTO users (id, email, name, password_hash, role, disabled, created_at)
VALUES (${sq(randomUUID())}, ${sq(to)}, ${name ? sq(name) : "NULL"}, '', 'admin', 0, ${now})
ON CONFLICT(email) DO UPDATE SET role = 'admin', disabled = 0, name = COALESCE(excluded.name, users.name);
UPDATE login_tokens SET used_at = ${now}
 WHERE used_at IS NULL AND kind = ${sq(kind)} AND user_id = (SELECT id FROM users WHERE email = ${sq(to)});
INSERT INTO login_tokens (token_hash, user_id, kind, created_at, expires_at)
SELECT ${sq(hash)}, id, ${sq(kind)}, ${now}, ${expires} FROM users WHERE email = ${sq(to)};
`;
const tmp = join(tmpdir(), `encore-invite-${randomBytes(6).toString("hex")}.sql`);
writeFileSync(tmp, sql, { mode: 0o600 });
try {
  wrangler(["d1", "execute", DB_NAME, where, "--yes", "--file", tmp]);
} finally {
  unlinkSync(tmp);
}

const link = `${base}/${kind === "invite" ? "set-password" : "reset-password"}#${token}`;
const what = activated ? "a password-reset link (expires in 1 hour)" : "an invite link (expires in 7 days)";
console.log(`\nAdmin ${to} ${rows.length ? "updated" : "created"} on ${remote ? "remote" : "local"} D1.`);

// 3. Deliver it.
if (email) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const body = activated
    ? `${greeting}\n\nHere is a link to set a new password for your ${APP} admin account:\n\n${link}\n\nThis link expires in 1 hour. If you didn't ask for this, ignore this email; your password won't change.\n`
    : `${greeting}\n\nAn admin account was created for you on ${APP}. Set a password to sign in:\n\n${link}\n\nThis link expires in 7 days.\n`;
  wrangler([
    "email", "sending", "send",
    "--from", FROM, "--from-name", APP, "--to", to,
    "--subject", activated ? `Reset your ${APP} password` : `Your ${APP} account`,
    "--text", body,
  ], true);
  console.log(`Emailed ${what} to ${to} from ${FROM}.\n`);
} else {
  console.log(`Here is ${what}:\n\n  ${link}\n`);
}
