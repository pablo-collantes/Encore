// Input normalisation for the account endpoints.

import type { AppContext } from "../middleware";

export function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

/** Trimmed single-line text, capped; "" when absent or not a string. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

/** The JSON object body, or a 400 response to return as-is. */
export async function objectBody(c: AppContext): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "Expected a JSON object." }, 400);
  return body as Record<string, unknown>;
}
