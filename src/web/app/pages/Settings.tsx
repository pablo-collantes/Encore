import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, ExternalLink, LogOut } from "lucide-react";
import { signOut } from "@/auth/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "../components/PageHeader";
import { PRESETS } from "../lib/range";
import { browserTimeZone, updateSettings, useSettings } from "../lib/settings";
import { fmtDateTime } from "../lib/format";
import { displayName, ROLE_LABEL, useMe } from "../lib/me";

const COMMON = ["UTC", "Europe/Madrid", "Europe/London", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];

export default function Settings() {
  const me = useMe();
  const settings = useSettings();
  const browser = browserTimeZone();
  const zones = useMemo(() => {
    let all: string[] = [];
    try {
      all = Intl.supportedValuesOf("timeZone");
    } catch {
      all = COMMON;
    }
    return [...new Set([browser, ...COMMON, ...all])];
  }, [browser]);
  const [open, setOpen] = useState(false);
  const current = settings.timeZone ?? browser;

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Settings" description="Preferences are saved on this device." />

      <Card>
        <CardHeader>
          <CardTitle>Time zone</CardTitle>
          <CardDescription>
            Days, hours of the day and streaks are calculated in this zone. Now: {fmtDateTime(Date.now(), current)}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" role="combobox" aria-expanded={open} aria-label="Time zone" className="w-full justify-between sm:w-80">
                {current}
                {settings.timeZone == null && <span className="ml-1 text-muted-foreground">(this device)</span>}
                <ChevronsUpDown className="ml-auto opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="start">
              <Command>
                <CommandInput placeholder="Search time zones…" />
                <CommandList>
                  <CommandEmpty>No zone found.</CommandEmpty>
                  <CommandGroup>
                    {zones.map((z) => (
                      <CommandItem
                        key={z}
                        value={z}
                        onSelect={() => {
                          updateSettings({ timeZone: z === browser ? null : z });
                          setOpen(false);
                        }}
                      >
                        <Check className={z === current ? "opacity-100" : "opacity-0"} />
                        {z}
                        {z === browser && <span className="ml-auto text-xs text-muted-foreground">this device</span>}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance & defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="dark-mode" className="flex flex-col items-start gap-0.5">
              <span>Dark theme</span>
              <span className="text-xs font-normal text-muted-foreground">Off switches to the light theme.</span>
            </Label>
            <Switch id="dark-mode" checked={settings.theme === "dark"} onCheckedChange={(c) => updateSettings({ theme: c ? "dark" : "light" })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="default-range" className="flex flex-col items-start gap-0.5">
              <span>Default date range</span>
              <span className="text-xs font-normal text-muted-foreground">Used when a link doesn't specify one.</span>
            </Label>
            <Select value={settings.defaultRange} onValueChange={(v) => updateSettings({ defaultRange: v })}>
              <SelectTrigger id="default-range" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Account <Badge variant={me.role === "admin" ? "default" : "secondary"}>{ROLE_LABEL[me.role]}</Badge>
          </CardTitle>
          <CardDescription>
            Signed in as <span className="font-medium text-foreground">{displayName(me)}</span>
            {me.email && me.email !== displayName(me) ? <> ({me.email})</> : null}.{" "}
            {me.role === "admin"
              ? "You can import data, reconnect Spotify and invite people."
              : "You can browse everything; importing and account changes are for admins."}{" "}
            To change your password, sign out and use “Forgot password?”.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void signOut()}>
            <LogOut /> Sign out
          </Button>
          <Button asChild variant="ghost">
            <a href="/health" target="_blank" rel="noreferrer">
              Collector health <ExternalLink />
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
