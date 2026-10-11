// Public pages: anyone on the internet can load these, so they show the app's
// name and nothing about what's inside. There is no sign-up page: accounts come
// from an admin's invite (/set-password#<token>), and a forgotten password is
// reset from an emailed link (/reset-password#<token>).
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { AuthError, forgotPassword, login, resetPassword, setPassword } from "./api";
import { Logo } from "./Logo";

const PRIMARY = "h-11 w-full rounded-full text-[15px] font-semibold shadow-lg shadow-primary/20";
const FIELD = "h-11 rounded-xl px-3.5";
const QUIET_LINK = "text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline";

const message = (err: unknown) => (err instanceof AuthError ? err.message : "Couldn't reach the server.");

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 animate-in fade-in duration-500">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <Logo className="size-14 drop-shadow-[0_8px_24px_color-mix(in_oklch,var(--primary)_35%,transparent)]" />
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

/** The one place errors appear: a single alert paragraph under the fields. */
function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  isNew,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
  /** New passwords carry the 8–200 character policy. */
  isNew?: boolean;
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <InputGroup className="h-11 rounded-xl">
        <InputGroupInput
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          minLength={isNew ? 8 : undefined}
          maxLength={isNew ? 200 : undefined}
          aria-describedby={describedBy}
          spellCheck={false}
          className="h-11 px-3.5"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown} onClick={() => setShown((s) => !s)}>
            {shown ? "Hide" : "Show"}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function EmailField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Email</Label>
      <Input
        id={id}
        type="email"
        inputMode="email"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        autoComplete="username"
        autoFocus
        spellCheck={false}
        className={FIELD}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function LoginPage({ next, offline }: { next: string; offline?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(offline ? "Couldn't reach the server." : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      // A full navigation: the gate boots again with the new session and opens the app at `next`.
      location.assign(next);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Encore" subtitle="Sign in to continue">
      <form onSubmit={submit} className="space-y-4" aria-label="Sign in">
        <EmailField id="login-email" value={email} onChange={setEmail} />
        <PasswordField id="login-password" label="Password" value={password} onChange={setPw} autoComplete="current-password" />
        {error && <FormError>{error}</FormError>}
        <Button type="submit" size="lg" className={PRIMARY} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-5 text-center">
        <a href="/forgot-password" className={QUIET_LINK}>
          Forgot password?
        </a>
      </p>
    </AuthShell>
  );
}

// The server answers the same for known and unknown addresses; so does this page.
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      // Only "we couldn't ask" is worth saying; any other answer looks like success.
      if (err instanceof AuthError && err.status !== 0 && err.status !== 429) setSent(true);
      else setError(message(err));
    }
    setBusy(false);
  };

  if (sent) {
    return (
      <AuthShell title="Check your inbox">
        <p role="status" className="text-center text-sm text-muted-foreground">
          If an account exists for that email, we've sent a link. It expires in 1 hour.
        </p>
        <Button asChild variant="outline" size="lg" className="mt-6 h-11 w-full rounded-full">
          <a href="/login">Back to sign in</a>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to set a new one.">
      <form onSubmit={submit} className="space-y-4" aria-label="Request a reset link">
        <EmailField id="forgot-email" value={email} onChange={setEmail} />
        {error && <FormError>{error}</FormError>}
        <Button type="submit" size="lg" className={PRIMARY} disabled={busy}>
          {busy ? "Sending…" : "Send reset link"}
        </Button>
      </form>
      <p className="mt-5 text-center">
        <a href="/login" className={QUIET_LINK}>
          Back to sign in
        </a>
      </p>
    </AuthShell>
  );
}

/**
 * Invite (set-password) and reset share this form; only the call and the ending
 * differ. The single-use token is spent only here, on submit: link scanners and
 * previews load pages but don't submit forms.
 */
function NewPasswordForm({
  submitLabel,
  busyLabel,
  onSubmit,
  onInvalidLink,
}: {
  submitLabel: string;
  busyLabel: string;
  onSubmit: (password: string) => Promise<void>;
  onInvalidLink: () => void;
}) {
  const [password, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Checked here first so a too-short password never reaches the server and burns the link.
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password.length > 200) return setError("Password must be at most 200 characters.");
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (err) {
      setBusy(false);
      // With the password already checked, a 400 means the link itself is no good.
      if (err instanceof AuthError && err.status === 400 && !/^password/i.test(err.message)) return onInvalidLink();
      setError(message(err));
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Set a password">
      <PasswordField
        id="new-password"
        label="New password"
        value={password}
        onChange={setPw}
        autoComplete="new-password"
        autoFocus
        isNew
        describedBy={hintId}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        At least 8 characters.
      </p>
      {error && <FormError>{error}</FormError>}
      <Button type="submit" size="lg" className={PRIMARY} disabled={busy}>
        {busy ? busyLabel : submitLabel}
      </Button>
    </form>
  );
}

export function SetPasswordPage({ token }: { token: string }) {
  const [invalid, setInvalid] = useState(!token);

  if (invalid) {
    return (
      <AuthShell title="This link doesn't work">
        <FormError>This invite link is invalid, expired or already used. Ask the person who invited you for a new one.</FormError>
        <p className="mt-6 text-center">
          <a href="/login" className={QUIET_LINK}>
            Go to sign in
          </a>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Welcome" subtitle="Set a password to finish creating your account.">
      <NewPasswordForm
        submitLabel="Set password and sign in"
        busyLabel="Saving…"
        onInvalidLink={() => setInvalid(true)}
        onSubmit={async (password) => {
          await setPassword(token, password);
          // Signed in by the same call: straight into the app.
          location.assign("/");
        }}
      />
    </AuthShell>
  );
}

export function ResetPasswordPage({ token }: { token: string }) {
  const [state, setState] = useState<"form" | "invalid" | "done">(token ? "form" : "invalid");

  if (state === "invalid") {
    return (
      <AuthShell title="This link doesn't work">
        <FormError>This reset link is invalid, expired or already used.</FormError>
        <Button asChild size="lg" className={`mt-6 ${PRIMARY}`}>
          <a href="/forgot-password">Request a new link</a>
        </Button>
        <p className="mt-5 text-center">
          <a href="/login" className={QUIET_LINK}>
            Back to sign in
          </a>
        </p>
      </AuthShell>
    );
  }

  if (state === "done") {
    return (
      <AuthShell title="Password updated">
        <p role="status" className="text-center text-sm text-muted-foreground">
          Sign in with your new password. Every other device has been signed out.
        </p>
        <Button asChild size="lg" className={`mt-6 ${PRIMARY}`}>
          <a href="/login">Sign in</a>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set a new password">
      <NewPasswordForm
        submitLabel="Update password"
        busyLabel="Saving…"
        onInvalidLink={() => setState("invalid")}
        onSubmit={async (password) => {
          await resetPassword(token, password);
          setState("done");
        }}
      />
    </AuthShell>
  );
}

export function Splash() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background" aria-busy="true">
      <Logo className="size-12 animate-pulse" />
    </main>
  );
}

/** Shown if the signed-in bundle can't be fetched (usually a deploy replaced it since this page loaded). */
export function LoadFailed() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold">Couldn't load the app</h1>
        <p className="mt-2 text-sm text-muted-foreground">A new version may have been deployed. Reloading usually fixes it.</p>
        <Button className="mt-6 rounded-full" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    </main>
  );
}
