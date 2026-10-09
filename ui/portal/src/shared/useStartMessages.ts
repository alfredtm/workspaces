// Stage messages ("Preparing your disk…") for rows that are coming up, so the
// wait reads as progress instead of a silent spinner. The per-workspace status
// endpoint returns a human message plus phase/reason/unreadySeconds; the
// caller hands us the fetch and folds it into a StartMessage (see status.ts).
import { useEffect, useRef, useState } from "react";
import { isStarting, type StartMessage } from "./status";

export function useStartMessages<T extends { name: string; replicas: number; ready: boolean }>(
  items: T[] | null,
  fetchMessage: (item: T) => Promise<StartMessage>,
  everyMs = 3000,
): Record<string, StartMessage> {
  const [msgs, setMsgs] = useState<Record<string, StartMessage>>({});
  const fetchRef = useRef(fetchMessage);
  fetchRef.current = fetchMessage;

  useEffect(() => {
    const starting = (items ?? []).filter(isStarting);
    if (starting.length === 0) {
      setMsgs({});
      return;
    }
    let live = true;
    const poll = async () => {
      const entries = await Promise.all(
        starting.map(async (item) => {
          const msg = await fetchRef.current(item).catch((): StartMessage | null => null);
          return [item.name, msg] as const;
        }),
      );
      if (live) {
        setMsgs(Object.fromEntries(entries.filter((e): e is readonly [string, StartMessage] => !!e[1]?.text)));
      }
    };
    poll();
    const id = setInterval(poll, everyMs);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [items, everyMs]);

  return msgs;
}
