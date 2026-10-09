// List plumbing: load the list, keep one error banner, poll while something
// is still coming up, and track which rows have an action in flight. The view
// keeps its copy and its markup; only the mechanics live here.
import { useCallback, useEffect, useRef, useState } from "react";

export type Banner = { tone: "success" | "error"; header: string; body?: string };

export type ResourceList<T> = {
  /** null while the first load is in flight — render the skeleton. */
  items: T[] | null;
  banner: Banner | null;
  setBanner: (b: Banner | null) => void;
  reload: () => void;
  /** True while an action on that row is in flight. */
  busy: (name: string) => boolean;
  /** Run an action for a row: busy on, banner on failure, reload after. */
  withBusy: (name: string, fn: () => Promise<void>, failHeader: string) => Promise<void>;
};

export function useResourceList<T>(opts: {
  /** Stable (useCallback) fetcher for the list. */
  load: () => Promise<T[]>;
  /** Nothing left to wait for on this item — stop polling when all are settled. */
  isSettled: (item: T) => boolean;
  /** Header for the "could not load" banner. */
  loadErrorHeader: string;
  /** Poll interval while something is unsettled but not starting. Default 10s. */
  pollMs?: number;
  /** Poll interval while something is starting. Default 2s. */
  startingMs?: number;
  /** Defaults to "not settled". */
  isStarting?: (item: T) => boolean;
}): ResourceList<T> {
  const { load, loadErrorHeader, pollMs = 10_000, startingMs = 2_000 } = opts;

  const [items, setItems] = useState<T[] | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});

  // Predicates are usually inline arrow functions: keep them out of effect
  // deps so a re-render never restarts the poll timer.
  const pred = useRef(opts);
  pred.current = opts;

  const reload = useCallback(() => {
    load()
      .then(setItems)
      .catch((e: Error) => {
        // A 401 has already redirected to the login flow — no banner for that.
        if (e.message !== "unauthorized") {
          setBanner({ tone: "error", header: loadErrorHeader, body: e.message });
        }
      });
  }, [load, loadErrorHeader]);

  useEffect(reload, [reload]);

  // Poll while anything is still coming up, so states flip on their own.
  useEffect(() => {
    const list = items ?? [];
    const unsettled = list.filter((i) => !pred.current.isSettled(i));
    if (unsettled.length === 0) return;
    const starting = pred.current.isStarting
      ? unsettled.some((i) => pred.current.isStarting!(i))
      : true;
    const id = setInterval(reload, starting ? startingMs : pollMs);
    return () => clearInterval(id);
  }, [items, reload, pollMs, startingMs]);

  const withBusy = useCallback(
    async (name: string, fn: () => Promise<void>, failHeader: string) => {
      setBusyMap((b) => ({ ...b, [name]: true }));
      try {
        await fn();
        setBanner(null);
      } catch (e) {
        setBanner({ tone: "error", header: failHeader, body: (e as Error).message });
      } finally {
        setBusyMap((b) => ({ ...b, [name]: false }));
        reload();
      }
    },
    [reload],
  );

  const busy = useCallback((name: string) => busyMap[name] === true, [busyMap]);

  return { items, banner, setBanner, reload, busy, withBusy };
}
