// Password hashing with PBKDF2-SHA256 over Web Crypto.
// Stored format: pbkdf2$<iterations>$<salt-b64>$<hash-b64>

// The Workers runtime caps PBKDF2 at 100k iterations: more throws
// NotSupportedError at the edge even though local dev and Node accept it, so a
// higher number passes every test and breaks in production. RL_AUTH's per-IP
// limit covers the rest of the brute-force story.
const PBKDF2_ITERATIONS = 100_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, KEY_BYTES * 8);
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  try {
    const salt = fromBase64(parts[2]!);
    const expected = fromBase64(parts[3]!);
    return timingSafeEqual(await deriveBits(password, salt, iterations), expected);
  } catch {
    return false;
  }
}

/** Returns an error sentence, or null if the password is acceptable. No composition rules. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}

// A valid-format hash, so signing in as an unknown email costs the same PBKDF2
// work as a real one (no account enumeration by timing).
let dummyHashPromise: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  return (dummyHashPromise ??= hashPassword("unused-placeholder-for-timing"));
}
