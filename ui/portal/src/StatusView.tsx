import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "./ui/Spinner";

// The whole point of this page: the checks run in YOUR browser, over the
// exact same network path (edge included) that the editor uses. Server-side
// health can be green while the edge eats WebSockets — this catches that.

type Level = "ok" | "degraded" | "down";

type Fleet = {
  clusterOk: boolean;
  running: number;
  starting: number;
  stuck: number;
};

type WsResult = { ok: boolean; ms: number };

const LEVEL_LABEL: Record<Level, string> = {
  ok: "Operational",
  degraded: "Degraded",
  down: "Disrupted",
};

function worst(...levels: Level[]): Level {
  if (levels.includes("down")) return "down";
  if (levels.includes("degraded")) return "degraded";
  return "ok";
}

// One real WebSocket through the edge: must open and survive a 3s hold.
function wsProbe(timeoutMs = 8000): Promise<WsResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve({ ok, ms: Math.round(performance.now() - t0) });
      }
    };
    let ws: WebSocket;
    try {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${scheme}://${window.location.host}/api/v1/ws-probe`);
    } catch {
      done(false);
      return;
    }
    const timeout = setTimeout(() => {
      done(false);
      ws.close();
    }, timeoutMs);
    ws.onopen = () => {
      // Opened — now survive a hold; premature close = edge cut us.
      setTimeout(() => {
        clearTimeout(timeout);
        done(true);
        ws.close();
      }, 3000);
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      done(false);
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      done(false);
    };
  });
}

export default function StatusView() {
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [fleetError, setFleetError] = useState(false);
  const [apiMs, setApiMs] = useState<number | null>(null);
  const [wsResults, setWsResults] = useState<WsResult[]>([]);
  const [checking, setChecking] = useState(true);
  const probing = useRef(false);

  const pushWs = (r: WsResult) => setWsResults((prev) => [...prev, r].slice(-10));

  const checkApi = useCallback(async () => {
    const t0 = performance.now();
    try {
      const res = await fetch("/api/v1/status");
      if (!res.ok) throw new Error();
      setFleet((await res.json()) as Fleet);
      setFleetError(false);
      setApiMs(Math.round(performance.now() - t0));
    } catch {
      setFleetError(true);
      setApiMs(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await checkApi();
      // Initial burst: three socket probes for a meaningful ratio.
      for (let i = 0; i < 3 && !cancelled; i++) {
        if (probing.current) break;
        probing.current = true;
        const r = await wsProbe();
        probing.current = false;
        if (!cancelled) pushWs(r);
      }
      if (!cancelled) setChecking(false);
    })();
    const interval = setInterval(async () => {
      await checkApi();
      if (!probing.current) {
        probing.current = true;
        const r = await wsProbe();
        probing.current = false;
        pushWs(r);
      }
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [checkApi]);

  const wsOk = wsResults.filter((r) => r.ok).length;
  const wsRate = wsResults.length ? wsOk / wsResults.length : 1;
  const wsAvg = wsResults.filter((r) => r.ok).length
    ? Math.round(wsResults.filter((r) => r.ok).reduce((a, r) => a + r.ms, 0) / wsOk)
    : null;

  const apiLevel: Level = fleetError ? "down" : apiMs !== null && apiMs > 1500 ? "degraded" : "ok";
  const wsLevel: Level =
    wsResults.length === 0 ? "ok" : wsRate === 1 ? "ok" : wsRate >= 0.7 ? "degraded" : "down";
  const provisioningLevel: Level = !fleet ? "ok" : fleet.stuck === 0 ? "ok" : fleet.stuck <= 2 ? "degraded" : "down";
  const clusterLevel: Level = !fleet ? "ok" : fleet.clusterOk ? "ok" : "down";
  const overall = checking ? null : worst(apiLevel, wsLevel, provisioningLevel, clusterLevel);

  const components: { name: string; level: Level; detail: string; metric: string }[] = [
    {
      name: "Portal & API",
      level: apiLevel,
      detail: fleetError ? "The portal API is unreachable from your browser." : "Dashboard, sign-in, and workspace controls.",
      metric: apiMs !== null ? `${apiMs} ms` : "—",
    },
    {
      name: "Editor connections",
      level: wsLevel,
      detail:
        wsLevel === "ok"
          ? "Live WebSocket test through the platform edge from your browser."
          : "Sockets from your browser are being disrupted at the platform edge — editors may reconnect repeatedly. This affects everyone and is not caused by your workspace.",
      metric: wsResults.length ? `${wsOk}/${wsResults.length} ok${wsAvg !== null ? ` · ${wsAvg} ms` : ""}` : "…",
    },
    {
      name: "Workspace provisioning",
      level: provisioningLevel,
      detail:
        provisioningLevel === "ok"
          ? "New and resumed workspaces are starting normally."
          : `${fleet?.stuck} workspace${(fleet?.stuck ?? 0) === 1 ? "" : "s"} stuck starting >5 min — usually platform storage delays. Waiting it out or recreating the pod normally recovers.`,
      metric: fleet ? `${fleet.running} running · ${fleet.starting} starting` : "…",
    },
    {
      name: "Cluster control plane",
      level: clusterLevel,
      detail: clusterLevel === "ok" ? "The manager can reach the Kubernetes API." : "The manager cannot reach the Kubernetes API.",
      metric: fleet ? (fleet.clusterOk ? "reachable" : "unreachable") : "…",
    },
  ];

  return (
    <div className="st-page">
      <header className="st-head">
        <h1>Status</h1>
        <p className="muted">Checked live from your browser, over the same path your editor uses.</p>
      </header>

      <div className={`st-summary st-${overall ?? "checking"}`} aria-live="polite">
        <span className="st-orb" aria-hidden="true" />
        <div>
          <h2 className="st-headline">
            {overall === null ? "Checking…" : overall === "ok" ? "All systems operational" : overall === "degraded" ? "Partially degraded" : "Platform disruption"}
          </h2>
          <p className="muted">
            {overall === null
              ? "Running connection tests"
              : overall === "ok"
                ? "Everything responded normally from here."
                : "Your workspaces and files are safe; this is about reaching them."}
          </p>
        </div>
        {overall === null && (
          <span className="st-summary-spinner">
            <Spinner size="lg" />
          </span>
        )}
      </div>

      <ul className="st-list">
        {components.map((comp) => (
          <li className="st-row" key={comp.name}>
            <span className={`st-dot st-${comp.level}`} aria-hidden="true" />
            <div className="st-row-text">
              <div className="st-name">
                {comp.name}
                <span className={`st-tag st-${comp.level}`}>{LEVEL_LABEL[comp.level]}</span>
              </div>
              <p className="muted st-detail">{comp.detail}</p>
            </div>
            <span className="mono muted st-metric">{comp.metric}</span>
          </li>
        ))}
      </ul>

      <p className="muted st-foot">
        Re-checks every 30 seconds while this page is open. Editor-connection problems shown here point at the
        network path between your browser and the cluster, not at your workspace.
      </p>
    </div>
  );
}
