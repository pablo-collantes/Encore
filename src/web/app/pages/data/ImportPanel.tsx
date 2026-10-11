import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileJson, FileArchive, Upload, X } from "lucide-react";
import { toast } from "sonner";
import type { FinishImportResponse } from "@shared/api";
import type { ParsedExportFile } from "@shared/exportFormats";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtDate, fmtInt, KIND_LABEL } from "../../lib/format";
import { effectiveTimeZone, useSettings } from "../../lib/settings";
import { readExportFiles, uploadImport, type UploadProgress } from "./importer";

type State =
  | { step: "idle" }
  | { step: "reading"; status: string }
  | { step: "review"; files: ParsedExportFile[] }
  | { step: "uploading"; files: ParsedExportFile[]; progress: UploadProgress }
  | { step: "done"; result: FinishImportResponse; inserted: number }
  | { step: "error"; message: string; files?: ParsedExportFile[] };

export function ImportPanel() {
  const [state, setState] = useState<State>({ step: "idle" });
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const client = useQueryClient();
  const tz = effectiveTimeZone(useSettings());

  const read = async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    setState({ step: "reading", status: "Reading files…" });
    try {
      const parsed = await readExportFiles(files, (status) => setState({ step: "reading", status }));
      setState({ step: "review", files: parsed });
    } catch (err) {
      setState({ step: "error", message: err instanceof Error ? `Couldn't read the files: ${err.message}` : "Couldn't read the files." });
    }
  };

  const start = async (files: ParsedExportFile[]) => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    const total = files.reduce((s, f) => s + f.rows.length, 0);
    setState({ step: "uploading", files, progress: { sentRows: 0, totalRows: total, inserted: 0, startedAt: Date.now(), phase: "uploading" } });
    try {
      let inserted = 0;
      const result = await uploadImport(
        files,
        (progress) => {
          inserted = progress.inserted;
          setState({ step: "uploading", files, progress });
        },
        ctrl.signal,
      );
      setState({ step: "done", result, inserted });
      toast.success(`Imported ${fmtInt(inserted)} new listens`);
      await client.invalidateQueries();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setState({ step: "review", files });
        toast("Import cancelled. Anything already uploaded is kept; importing again is safe.");
        return;
      }
      setState({ step: "error", files, message: err instanceof Error ? err.message : "The upload failed." });
      await client.invalidateQueries();
    }
  };

  const busy = state.step === "reading" || state.step === "uploading";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import your Spotify data</CardTitle>
        <CardDescription>
          Drop the zip Spotify emails you (or the JSON files inside it). It's read in your browser; only the listening history is
          uploaded. Importing the same files twice is safe.
        </CardDescription>
        {state.step !== "idle" && !busy && (
          <CardAction>
            <Button variant="ghost" size="sm" onClick={() => setState({ step: "idle" })}>
              <X /> Start over
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {(state.step === "idle" || state.step === "error") && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose Spotify data files to import"
            onClick={() => input.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                input.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void read(e.dataTransfer.files);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/40",
            )}
          >
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Upload className="size-5" aria-hidden />
            </div>
            <div>
              <div className="font-medium">Drag & drop, or click to choose</div>
              <div className="mt-1 text-sm text-muted-foreground">
                <span className="font-mono text-xs">my_spotify_data.zip</span>, or{" "}
                <span className="font-mono text-xs">Streaming_History_Audio_*.json</span> /{" "}
                <span className="font-mono text-xs">StreamingHistory_music_*.json</span>
              </div>
            </div>
            <input
              ref={input}
              type="file"
              accept=".zip,.json,application/zip,application/json"
              multiple
              className="sr-only"
              onChange={(e) => {
                void read(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {state.step === "error" && (
          <Alert variant="destructive">
            <AlertTitle>Import failed</AlertTitle>
            <AlertDescription>
              {state.message}
              {state.files && (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => void start(state.files!)}>
                  Try again
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {state.step === "reading" && (
          <div className="flex items-center gap-3 rounded-xl border p-6 text-sm" role="status">
            <Spinner /> {state.status}
          </div>
        )}

        {(state.step === "review" || state.step === "uploading") && <FileReview files={state.files} tz={tz} />}

        {state.step === "review" && <ReviewActions files={state.files} onStart={() => void start(state.files)} />}

        {state.step === "uploading" && (
          <UploadStatus progress={state.progress} onCancel={() => abort.current?.abort()} />
        )}

        {state.step === "done" && (
          <Alert>
            <CheckCircle2 className="text-primary" />
            <AlertTitle>Import complete</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 grid gap-0.5 text-sm">
                <li>
                  <span className="font-medium text-foreground tabular">{fmtInt(state.inserted)}</span> new listens added (
                  {fmtInt(state.result.batch.rowsReceived)} in the files)
                </li>
                <li>
                  <span className="font-medium text-foreground tabular">{fmtInt(state.result.cleanup.duplicates)}</span> overlaps with
                  data you already had were hidden as duplicates
                </li>
                <li>
                  <span className="font-medium text-foreground tabular">{fmtInt(state.result.cleanup.resolvedByName)}</span> name-only
                  listens matched to Spotify tracks
                </li>
                {state.result.cleanup.mergedArtists > 0 && (
                  <li>
                    <span className="font-medium text-foreground tabular">{fmtInt(state.result.cleanup.mergedArtists)}</span> artists
                    merged
                  </li>
                )}
              </ul>
              <p className="mt-2 text-xs">
                Artwork, genres and audio features for new tracks are fetched in the background over the next hours.
              </p>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function FileReview({ files, tz }: { files: ParsedExportFile[]; tz: string }) {
  const history = files.filter((f) => f.kind !== "other");
  const other = files.filter((f) => f.kind === "other");
  return (
    <div className="space-y-2">
      {history.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead className="hidden sm:table-cell">Type</TableHead>
              <TableHead className="text-right">Listens</TableHead>
              <TableHead className="hidden text-right md:table-cell">Covers</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((f, i) => (
              <TableRow key={`${f.name}-${i}`}>
                <TableCell className="max-w-0 w-full">
                  <div className="flex items-center gap-2">
                    <FileJson className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate font-mono text-xs">{f.name}</span>
                  </div>
                  <div className="text-xs text-muted-foreground sm:hidden">{KIND_LABEL[f.kind]}</div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge variant={f.kind.startsWith("extended") ? "default" : "secondary"}>{KIND_LABEL[f.kind]}</Badge>
                </TableCell>
                <TableCell className="text-right tabular">
                  {fmtInt(f.rows.length)}
                  {f.dropped > 0 && <div className="text-[11px] text-muted-foreground">{fmtInt(f.dropped)} skipped</div>}
                </TableCell>
                <TableCell className="hidden text-right text-xs text-muted-foreground md:table-cell">
                  {fmtDate(f.firstTs, tz)} – {fmtDate(f.lastTs, tz)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {other.length > 0 && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">
            <FileArchive className="mr-1 inline size-4 align-text-bottom" aria-hidden />
            {fmtInt(other.length)} other {other.length === 1 ? "file" : "files"} skipped (library, playlists, account info…)
          </summary>
          <ul className="mt-2 ml-6 list-disc text-xs">
            {other.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <span className="font-mono">{f.name}</span> — {f.note ?? "not listening history"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ReviewActions({ files, onStart }: { files: ParsedExportFile[]; onStart: () => void }) {
  const total = files.reduce((s, f) => s + (f.kind === "other" ? 0 : f.rows.length), 0);
  const hasExtended = files.some((f) => f.kind.startsWith("extended") && f.rows.length > 0);
  const hasAccount = files.some((f) => f.kind.startsWith("account") && f.rows.length > 0);
  if (total === 0) {
    return (
      <Alert>
        <AlertTitle>No listening history found</AlertTitle>
        <AlertDescription>
          These files don't contain streaming history. Look for <span className="font-mono">Streaming_History_Audio_*.json</span> or{" "}
          <span className="font-mono">StreamingHistory_music_*.json</span> inside the download.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm">
        <div className="font-medium">Ready to import {fmtInt(total)} listens</div>
        <div className="text-muted-foreground">
          {hasExtended && hasAccount
            ? "Both formats found; where they overlap, the extended history wins."
            : hasAccount
              ? "Account data has names but no Spotify IDs; tracks are matched up after the import."
              : "Extended history: the most detailed format."}
        </div>
      </div>
      <Button onClick={onStart} className="rounded-full">
        <Upload /> Import {fmtInt(total)} listens
      </Button>
    </div>
  );
}

function UploadStatus({ progress, onCancel }: { progress: UploadProgress; onCancel: () => void }) {
  const pct = progress.totalRows ? (progress.sentRows / progress.totalRows) * 100 : 0;
  const secs = (Date.now() - progress.startedAt) / 1000;
  const rate = secs > 0 ? progress.sentRows / secs : 0;
  return (
    <div className="space-y-2 rounded-xl border p-4" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <Spinner />
          {progress.phase === "finishing" ? "Cleaning up: matching tracks and removing overlaps…" : "Uploading…"}
        </span>
        {progress.phase === "uploading" && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <Progress value={progress.phase === "finishing" ? 100 : pct} aria-label="Upload progress" className="h-2" />
      <div className="flex justify-between text-xs text-muted-foreground tabular">
        <span>
          {fmtInt(progress.sentRows)} / {fmtInt(progress.totalRows)} listens · {fmtInt(progress.inserted)} new
        </span>
        {rate > 0 && progress.phase === "uploading" && <span>{fmtInt(rate)} / s</span>}
      </div>
    </div>
  );
}
