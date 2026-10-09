// One status vocabulary for the workspace list. The manager reports the raw
// pair — replicas + ready — and the words, the dot colour and the spinner are
// the portal's job.

export type ResourceState = "ok" | "starting" | "slow" | "paused" | "error";

export type ResourceStatus = {
  state: ResourceState;
  label: string;
  /** True while the resource is on its way up: show a spinner, poll faster. */
  spinner: boolean;
};

/** The extra fields the per-workspace status endpoint returns while a pod is unready. */
export type StartDetail = { phase?: string; reason?: string; unreadySeconds?: number };

/** A start reads as "slow" after this long unready, even with no named problem. */
export const SLOW_START_SECONDS = 180;

/**
 * Whether a start deserves the warning treatment: the cluster has named a
 * problem (FailedAttachVolume, ImagePullBackOff, …) or it has simply been
 * too long. The manager already turned the reason into user-facing text.
 */
export const isSlowStart = (d: StartDetail) => !!d.reason || (d.unreadySeconds ?? 0) > SLOW_START_SECONDS;

/** The stage line the shared start-message hook carries per starting row. */
export type StartMessage = { text: string; slow: boolean };

export const startMessage = (text: string, d: StartDetail): StartMessage => ({ text, slow: isSlowStart(d) });

/**
 * The raw pair every list row carries, plus `startFailed` (the manager gave up
 * on the last start and left its reason on the row).
 */
export type ReplicaState = { replicas: number; ready: boolean; startFailed?: string };

/**
 * replicas/ready (+ the current stage line) → Running / Starting / Slow /
 * Paused — or Failed, when `startFailed` is set. The normal Resume action
 * still applies: a failed start is a paused resource with a story.
 */
export function replicaStatus(r: ReplicaState, start?: StartMessage): ResourceStatus {
  if (r.ready) return { state: "ok", label: "Running", spinner: false };
  if (r.replicas > 0) {
    if (start?.slow) return { state: "slow", label: start.text, spinner: true };
    return { state: "starting", label: start?.text || "Starting…", spinner: true };
  }
  if (r.startFailed) return { state: "error", label: r.startFailed, spinner: false };
  return { state: "paused", label: "Paused", spinner: false };
}

/**
 * The retention line for a paused row the manager has flagged as idle
 * ("Unused for 9 days — deleted after 14 days unless opened"), or "" when
 * there is nothing to say. Numbers come from the API so the copy can never
 * disagree with what the manager will actually do.
 */
export function retentionNotice(r: {
  replicas: number;
  ready: boolean;
  idleWarning?: boolean;
  idleDays?: number;
  deleteAfterDays?: number;
}): string {
  if (!r.idleWarning || r.ready || r.replicas > 0) return "";
  const days = r.idleDays ?? 0;
  const unused = `Unused for ${days} ${days === 1 ? "day" : "days"}`;
  if (!r.deleteAfterDays) return unused;
  return `${unused} — deleted after ${r.deleteAfterDays} days unless opened`;
}

/** Nothing left to wait for: either up, or deliberately down. */
export const isSettled = (r: ReplicaState) => r.ready || r.replicas === 0;

/** Scaled up but not serving yet. */
export const isStarting = (r: ReplicaState) => r.replicas > 0 && !r.ready;
