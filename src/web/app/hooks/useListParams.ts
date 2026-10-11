import { useCallback } from "react";
import { useSearchParams } from "react-router";

/** Search text, sort and page for a list page, kept in the URL next to the range. */
export function useListParams(defaultSort = "ms", pageSize = 50) {
  const [search, setSearch] = useSearchParams();
  const q = search.get("q") ?? "";
  const sort = search.get("sort") ?? defaultSort;
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);

  const set = useCallback(
    (patch: { q?: string; sort?: string; page?: number }) => {
      const s = new URLSearchParams(search);
      if (patch.q !== undefined) {
        if (patch.q) s.set("q", patch.q);
        else s.delete("q");
        s.delete("page");
      }
      if (patch.sort !== undefined) {
        if (patch.sort !== defaultSort) s.set("sort", patch.sort);
        else s.delete("sort");
        s.delete("page");
      }
      if (patch.page !== undefined) {
        if (patch.page > 1) s.set("page", String(patch.page));
        else s.delete("page");
      }
      setSearch(s, { replace: patch.q !== undefined });
    },
    [search, setSearch, defaultSort],
  );

  return { q, sort, page, pageSize, offset: (page - 1) * pageSize, set };
}
