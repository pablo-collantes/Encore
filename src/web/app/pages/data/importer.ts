// Client side of an import: read Spotify's zip/JSON files, turn them into
// ImportRows with the shared parser, and upload them in chunks.
import { unzip, type Unzipped } from "fflate";
import type { CreateImportResponse, FinishImportResponse, ImportRowsResponse } from "@shared/api";
import { isCandidateExportPath, parseExportFile, type ImportRow, type ParsedExportFile } from "@shared/exportFormats";
import { apiPost } from "../../lib/api";

export const CHUNK_ROWS = 4000;
const CONCURRENCY = 2;
const RETRIES = 3;

/** Let the browser paint (spinner, progress) before a blocking step. */
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Unzip off the main thread (fflate runs inflate in blob: workers; the CSP allows them). */
function unzipAsync(data: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) =>
    unzip(data, { filter: (f) => isCandidateExportPath(f.name) && (f.compression === 0 || f.compression === 8) }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );
}

/**
 * Read every listening-history file out of the dropped files. The UI yields
 * between files so progress keeps painting while large JSON files parse.
 */
export async function readExportFiles(files: File[], onStatus: (s: string) => void): Promise<ParsedExportFile[]> {
  const out: ParsedExportFile[] = [];
  const decoder = new TextDecoder();
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      onStatus(`Opening ${file.name}…`);
      await yieldToUi();
      const entries = await unzipAsync(new Uint8Array(await file.arrayBuffer()));
      for (const [path, data] of Object.entries(entries)) {
        onStatus(`Reading ${path.split("/").pop()}…`);
        await yieldToUi();
        out.push(parseExportFile(path, decoder.decode(data)));
      }
    } else if (/\.json$/i.test(file.name)) {
      onStatus(`Reading ${file.name}…`);
      await yieldToUi();
      out.push(parseExportFile(file.name, await file.text()));
    } else {
      out.push({ name: file.name, kind: "other", rows: [], dropped: 0, firstTs: null, lastTs: null, note: "not a .zip or .json file" });
    }
  }
  return out;
}

export interface UploadProgress {
  sentRows: number;
  totalRows: number;
  inserted: number;
  startedAt: number;
  phase: "uploading" | "finishing";
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** Create an import batch, upload all rows in chunks, then ask the Worker to clean up. */
export async function uploadImport(
  parsed: ParsedExportFile[],
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
): Promise<FinishImportResponse> {
  const history = parsed.filter((f) => f.kind !== "other" && f.rows.length > 0);
  const rows: ImportRow[] = history.flatMap((f) => f.rows).sort((a, b) => a.ts - b.ts);
  const { id } = await apiPost<CreateImportResponse>(
    "/api/imports",
    { files: history.map((f) => ({ name: f.name, kind: f.kind, rows: f.rows.length })) },
    signal,
  );

  const chunks: ImportRow[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) chunks.push(rows.slice(i, i + CHUNK_ROWS));

  const progress: UploadProgress = { sentRows: 0, totalRows: rows.length, inserted: 0, startedAt: Date.now(), phase: "uploading" };
  onProgress({ ...progress });

  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++]!;
      const res = await withRetry(
        () => apiPost<ImportRowsResponse>(`/api/imports/${encodeURIComponent(id)}/rows`, { rows: chunk }, signal),
        signal,
      );
      progress.sentRows += chunk.length;
      progress.inserted += res.inserted;
      onProgress({ ...progress });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

  progress.phase = "finishing";
  onProgress({ ...progress });
  return withRetry(() => apiPost<FinishImportResponse>(`/api/imports/${encodeURIComponent(id)}/finish`, {}, signal), signal);
}
