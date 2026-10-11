// People: invite someone, and manage who has access. Admins only; the Worker
// enforces that on every /api/admin call, this page just doesn't offer it to
// anyone else.
//
// Invite and reset links are always shown with a Copy button, emailed or not:
// email is a convenience, the link is what actually lets someone in. Destructive
// actions confirm inline ("Delete" -> "Confirm delete?"), never window.confirm().
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, MailCheck, MailWarning, ShieldCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";
import type { AdminLinkResponse, AdminUser, Role } from "@shared/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { PageHeader } from "../components/PageHeader";
import { RLink } from "../components/RLink";
import { ErrorState, RowsSkeleton } from "../components/States";
import { ADMIN_USERS, useAdminUsers } from "../hooks/queries";
import { apiDelete, apiPatch, apiPost } from "../lib/api";
import { fmtRelative, initials } from "../lib/format";
import { ROLE_LABEL, useMe } from "../lib/me";

/** A freshly minted link, plus what we need to describe it. */
type LinkResult = AdminLinkResponse & { email: string; asked: boolean };

/** The chosen role reads as chosen (the toggle's default "on" grey is too faint here). */
const ROLE_OPTION = "px-3 data-[state=on]:border-primary/60 data-[state=on]:bg-primary/15 data-[state=on]:text-foreground";

const STATUS_BADGE: Record<string, string> = {
  Active: "",
  Invited: "border-dashed text-muted-foreground",
  Disabled: "",
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Please try again.");

export default function Admin() {
  const me = useMe();
  if (me.role !== "admin") return <AdminsOnly />;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="People"
        description="Accounts are invite-only. Admins can import data, reconnect Spotify and manage people; viewers can only look."
      />
      <InviteCard />
      <PeopleCard meId={me.id} />
    </div>
  );
}

function AdminsOnly() {
  return (
    <Empty className="mt-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldCheck />
        </EmptyMedia>
        <EmptyTitle>Admins only</EmptyTitle>
        <EmptyDescription>Only an admin can see and manage who has access.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild size="sm">
          <RLink to="/">Back to overview</RLink>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

// ---------------------------------------------------------------------------

function InviteCard() {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LinkResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await apiPost<AdminLinkResponse>(ADMIN_USERS, { email: email.trim(), name: name.trim() || undefined, role, sendEmail });
      setResult({ ...r, email: r.user?.email ?? email.trim(), asked: sendEmail });
      setEmail("");
      setName("");
      setRole("user");
      await client.invalidateQueries({ queryKey: [ADMIN_USERS] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="size-4" aria-hidden /> Invite someone
        </CardTitle>
        <CardDescription>They get a link to choose a password. It works once and expires in 7 days.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5" aria-label="Invite someone">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-name">
                Name <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input id="invite-name" autoComplete="off" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Role</legend>
            <ToggleGroup type="single" variant="outline" value={role} onValueChange={(v) => v && setRole(v as Role)} aria-label="Role">
              <ToggleGroupItem value="user" className={ROLE_OPTION}>
                {ROLE_LABEL.user}
              </ToggleGroupItem>
              <ToggleGroupItem value="admin" className={ROLE_OPTION}>
                {ROLE_LABEL.admin}
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {role === "admin" ? "Can import data, reconnect Spotify and manage people." : "Can browse everything and change nothing."}
            </p>
          </fieldset>

          <div className="flex items-center gap-2">
            <Checkbox id="invite-send" checked={sendEmail} onCheckedChange={(c) => setSendEmail(c === true)} />
            <Label htmlFor="invite-send" className="font-normal">
              Email the invite link
            </Label>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? (sendEmail ? "Sending…" : "Creating…") : sendEmail ? "Send invite" : "Create invite"}
          </Button>
        </form>
        {result && <LinkResultPanel r={result} className="mt-5" />}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function PeopleCard({ meId }: { meId: string }) {
  const q = useAdminUsers(true);
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Record<string, LinkResult>>({});

  /** Run one row's action: one place for busy state, its error and the refresh. */
  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setErrors(({ [id]: _, ...rest }) => rest);
    try {
      await fn();
      await client.invalidateQueries({ queryKey: [ADMIN_USERS] });
    } catch (err) {
      setErrors((m) => ({ ...m, [id]: errorText(err) }));
    } finally {
      setBusy(null);
    }
  };

  const users = q.data?.users;
  const who = (u: AdminUser) => u.name || u.email;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          People {users && <span className="font-normal text-muted-foreground tabular">({users.length})</span>}
        </CardTitle>
        <CardDescription>
          Someone shows as Invited until they set a password. Disabling or deleting an account signs it out everywhere.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !users ? (
          <RowsSkeleton rows={3} art={false} />
        ) : (
          <ul className="divide-y" aria-label="People">
            {users.map((u) => (
              <PersonRow
                key={u.id}
                u={u}
                self={u.id === meId}
                busy={busy !== null}
                error={errors[u.id]}
                link={links[u.id]}
                onLink={() =>
                  act(u.id, async () => {
                    const r = await apiPost<AdminLinkResponse>(`${ADMIN_USERS}/${encodeURIComponent(u.id)}/link`, { sendEmail: true });
                    setLinks((m) => ({ ...m, [u.id]: { ...r, email: u.email, asked: true } }));
                  })
                }
                onRole={() =>
                  act(u.id, async () => {
                    const role: Role = u.role === "admin" ? "user" : "admin";
                    await apiPatch(`${ADMIN_USERS}/${encodeURIComponent(u.id)}`, { role });
                    toast.success(`${who(u)} is now ${role === "admin" ? "an admin" : "a viewer"}.`);
                  })
                }
                onDisabled={(disabled) =>
                  act(u.id, async () => {
                    await apiPatch(`${ADMIN_USERS}/${encodeURIComponent(u.id)}`, { disabled });
                    toast.success(disabled ? `${who(u)} is disabled and signed out.` : `${who(u)} can sign in again.`);
                  })
                }
                onDelete={() =>
                  act(u.id, async () => {
                    await apiDelete(`${ADMIN_USERS}/${encodeURIComponent(u.id)}`);
                    setLinks(({ [u.id]: _, ...rest }) => rest);
                    toast.success(`Deleted ${u.email}.`);
                  })
                }
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PersonRow({
  u,
  self,
  busy,
  error,
  link,
  onLink,
  onRole,
  onDisabled,
  onDelete,
}: {
  u: AdminUser;
  self: boolean;
  busy: boolean;
  error?: string;
  link?: LinkResult;
  onLink: () => void;
  onRole: () => void;
  onDisabled: (disabled: boolean) => void;
  onDelete: () => void;
}) {
  const status = u.disabled ? "Disabled" : u.activated ? "Active" : "Invited";
  const seen = u.disabled
    ? "Disabled"
    : u.activated
      ? u.lastLoginAt
        ? `Last signed in ${fmtRelative(u.lastLoginAt)}`
        : "Never signed in"
      : u.lastLinkAt
        ? `Invite sent ${fmtRelative(u.lastLinkAt)}`
        : "Invite not sent yet";

  return (
    <li className="py-4 first:pt-0 last:pb-0" aria-label={u.email}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-9 rounded-lg">
            <AvatarFallback className="rounded-lg">{initials(u.name || u.email)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-medium">{u.name || u.email}</span>
              {self && <span className="text-xs text-muted-foreground">(this is you)</span>}
              <Badge variant={u.role === "admin" ? "default" : "secondary"}>{ROLE_LABEL[u.role]}</Badge>
              <Badge variant={status === "Disabled" ? "destructive" : "outline"} className={STATUS_BADGE[status]}>
                {status}
              </Badge>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {u.name ? `${u.email} · ` : ""}
              {seen}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {!u.disabled && (
            <Button size="sm" variant="outline" disabled={busy} onClick={onLink}>
              {u.activated ? "Send reset link" : "Resend invite"}
            </Button>
          )}
          {/* No demote, disable or delete on your own row: there is always an admin left. */}
          {!self && (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onRole}>
                {u.role === "admin" ? "Make viewer" : "Make admin"}
              </Button>
              {u.disabled ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDisabled(false)}>
                  Enable
                </Button>
              ) : (
                <ConfirmButton label="Disable" question="Confirm disable?" disabled={busy} onConfirm={() => onDisabled(true)} />
              )}
              <ConfirmButton label="Delete" question="Confirm delete?" disabled={busy} onConfirm={onDelete} />
            </>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {link && <LinkResultPanel r={link} className="mt-3" />}
    </li>
  );
}

/** First click arms it ("Confirm delete?"), the second acts; Cancel disarms. */
function ConfirmButton({ label, question, disabled, onConfirm }: { label: string; question: string; disabled: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="destructive"
        disabled={disabled}
        autoFocus
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {question}
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </>
  );
}

// ---------------------------------------------------------------------------

/** What happened to a freshly minted invite/reset link, then the link itself. */
function LinkResultPanel({ r, className }: { r: LinkResult; className?: string }) {
  const expiry = r.kind === "invite" ? "It works once and expires in 7 days." : "It works once and expires in 1 hour.";
  const what = r.kind === "invite" ? "Invite" : "Reset link";
  // The detail may already carry the "Email was not sent" lead-in; say it once.
  const detail = r.emailDetail?.replace(/^email was not sent:?\s*/i, "").trim();
  return (
    <div role="status" className={cn("space-y-2.5 rounded-lg border bg-muted/30 p-3 text-sm", className)}>
      <p className="flex items-start gap-2">
        {r.emailed ? (
          <MailCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        ) : r.asked ? (
          <MailWarning className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        ) : null}
        <span>
          {r.emailed ? (
            <>
              {what} emailed to <strong className="font-medium">{r.email}</strong>. {expiry}
            </>
          ) : r.asked ? (
            <>
              Email was not sent{detail ? `: ${detail}` : "."} Send <strong className="font-medium">{r.email}</strong> this link
              another way. {expiry}
            </>
          ) : (
            <>
              Send <strong className="font-medium">{r.email}</strong> this link. {expiry}
            </>
          )}
        </span>
      </p>
      <CopyLink url={r.url} />
      <p className="text-xs text-muted-foreground">Making a new link for this person retires this one.</p>
    </div>
  );
}

/** Read-only link + Copy. If the clipboard is refused, the text is selected for a manual copy. */
function CopyLink({ url }: { url: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"ok" | "select" | null>(null);

  useEffect(() => {
    if (copied !== "ok") return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      input.current?.focus();
      input.current?.select();
      setCopied("select");
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Input
          ref={input}
          readOnly
          value={url}
          aria-label="Link"
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" className="shrink-0" onClick={() => void copy()}>
          {copied === "ok" ? (
            <>
              <Check aria-hidden /> Copied!
            </>
          ) : (
            <>
              <Copy aria-hidden /> Copy link
            </>
          )}
        </Button>
      </div>
      {copied === "select" && <p className="text-xs text-muted-foreground">Selected. Press Ctrl+C (⌘C on a Mac) to copy it.</p>}
    </div>
  );
}
