import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ImportBatch } from "@shared/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiDelete } from "../../lib/api";
import { fmtDate, fmtDateTime, fmtInt } from "../../lib/format";

/** `canEdit`: admins can remove an import; everyone else sees the list read-only. */
export function ImportHistory({ imports, tz, canEdit }: { imports: ImportBatch[]; tz: string; canEdit: boolean }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const client = useQueryClient();

  const remove = async (id: string) => {
    setDeleting(id);
    try {
      await apiDelete(`/api/imports/${encodeURIComponent(id)}`);
      toast.success("Import removed");
      await client.invalidateQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the import");
    } finally {
      setDeleting(null);
      setConfirming(null);
    }
  };

  return (
    <Card className="py-2">
      <CardHeader className="pt-4">
        <CardTitle>Imports</CardTitle>
        <CardDescription>
          Each upload, newest first.{canEdit ? " Removing one deletes the listens it added." : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-4">
        {imports.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">Nothing imported yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead className="hidden md:table-cell">Files</TableHead>
                <TableHead className="text-right">Added</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Covers</TableHead>
                {canEdit && (
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {imports.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <div className="text-sm">{fmtDateTime(b.createdAt, tz)}</div>
                    <Badge variant={b.status === "done" ? "secondary" : b.status === "failed" ? "destructive" : "outline"} className="mt-1">
                      {b.status === "done" ? "Done" : b.status === "failed" ? "Failed" : "Incomplete"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden max-w-48 md:table-cell">
                    <div className="truncate font-mono text-xs" title={b.files.map((f) => f.name).join("\n")}>
                      {b.files.map((f) => f.name).join(", ")}
                    </div>
                    <div className="text-xs text-muted-foreground">{fmtInt(b.files.length)} files</div>
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {fmtInt(b.rowsInserted)}
                    <div className="text-xs text-muted-foreground">
                      of {fmtInt(b.rowsReceived)}
                      {b.duplicates ? ` · ${fmtInt(b.duplicates)} dup` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right text-xs whitespace-normal text-muted-foreground sm:table-cell">
                    <div>{fmtDate(b.firstTs, tz)} –</div>
                    <div>{fmtDate(b.lastTs, tz)}</div>
                  </TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      {confirming === b.id ? (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="destructive" disabled={deleting === b.id} onClick={() => void remove(b.id)}>
                            {deleting === b.id ? "Removing…" : "Confirm remove?"}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={deleting === b.id} onClick={() => setConfirming(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button size="icon-sm" variant="ghost" aria-label="Remove this import" onClick={() => setConfirming(b.id)}>
                          <Trash2 />
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
