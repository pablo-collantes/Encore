// Invite / reset emails through the Worker's `send_email` binding (Cloudflare
// Email Sending; the platform authenticates the binding, so there is no token).
//
// Email is a convenience, never a dependency: the admin endpoints always return
// the link too, and a failed send is reported, not thrown.

import type { Env } from "../types";

export interface EmailResult {
  ok: boolean;
  /** Why it wasn't sent, safe to show an admin. Never contains a token. */
  detail?: string;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
  link: string;
}

export async function sendEmail(env: Env, msg: EmailContent & { to: string; replyTo?: string | null }): Promise<EmailResult> {
  if (!env.EMAIL || !env.EMAIL_FROM) {
    // A runtime without the binding: say so, and log the link so the flow can be finished by hand.
    console.log(`[email] not sent (no EMAIL binding) to ${msg.to}: "${msg.subject}"\n  ${msg.link}`);
    return { ok: false, detail: "Email is not configured here." };
  }
  try {
    await env.EMAIL.send({
      from: { name: env.APP_NAME || "Encore", email: env.EMAIL_FROM },
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    });
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error(`[email] send to ${msg.to} failed: ${e.code ?? ""} ${e.message ?? String(err)}`);
    return { ok: false, detail: `Email was not sent: ${e.code || e.message || "send failed"}` };
  }
}

/** Links go to the host this request arrived on, so dev links point at dev. */
export function linkBase(env: Env, requestUrl: string): string {
  try {
    const { origin, protocol } = new URL(requestUrl);
    if (protocol === "https:" || protocol === "http:") return origin;
  } catch {
    /* fall through */
  }
  return env.APP_URL.replace(/\/+$/, "");
}

// Tokens travel in the URL fragment, which browsers never send to a server, put
// in a Referer, or hand to a chat app's link-preview bot.
export const inviteUrl = (base: string, token: string) => `${base}/set-password#${token}`;
export const resetUrl = (base: string, token: string) => `${base}/reset-password#${token}`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function render(lines: string[], link: string, cta: string, footer: string): Omit<EmailContent, "subject"> {
  const text = `${lines.join("\n\n")}\n\n${link}\n\n${footer}\n`;
  const html =
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
    `<p><a href="${escapeHtml(link)}">${escapeHtml(cta)}</a></p>` +
    `<p style="color:#888;font-size:12px">${escapeHtml(footer)}</p>`;
  return { text, html, link };
}

export function inviteEmail(env: Env, base: string, token: string, name: string | null): EmailContent {
  const app = env.APP_NAME || "Encore";
  return {
    subject: `Your ${app} account`,
    ...render(
      [name ? `Hi ${name},` : "Hi,", `An account was created for you on ${app}. Set a password to sign in:`],
      inviteUrl(base, token),
      "Set your password",
      "This link expires in 7 days.",
    ),
  };
}

export function resetEmail(env: Env, base: string, token: string): EmailContent {
  const app = env.APP_NAME || "Encore";
  return {
    subject: `Reset your ${app} password`,
    ...render(
      [`A password reset was requested for your ${app} account. Set a new password here:`],
      resetUrl(base, token),
      "Reset your password",
      "This link expires in 1 hour. If you didn't ask for this, ignore this email; your password won't change.",
    ),
  };
}
