// Thin typed client for the manager's JSON API. All mutations carry the
// CSRF token from /api/v1/me in a header; a 401 anywhere bounces through the
// OIDC login flow.

export type Me = {
  upn: string;
  displayName: string;
  username: string;
  csrfToken: string;
  activeLimit: number;
};

/**
 * Lifecycle fields every list endpoint carries per row (see
 * services/manager/lifecycle.go): a failed start the manager gave up on, and
 * the idle retention warning.
 */
export type Lifecycle = {
  /** Card line when the last start was stopped by the manager ("Couldn't start: …"); "" otherwise. */
  startFailed: string;
  /** Whole days since last activity. */
  idleDays: number;
  /** True once the retention warning has been set (idle ≥ IDLE_WARN_DAYS). */
  idleWarning: boolean;
  /** Configured IDLE_DELETE_DAYS; 0 = idle resources are never deleted. */
  deleteAfterDays: number;
};

export type Workspace = Lifecycle & {
  name: string;
  slug: string;
  repo: string;
  url: string;
  replicas: number;
  ready: boolean;
};

export type WorkspaceStatus = {
  state: string;
  ready: boolean;
  message: string;
  redirect: string;
  /** Coarse stage while unready (storage, image, scheduling, …); "" once ready/stopped. */
  phase: string;
  /** Kubernetes reason word behind `message` (FailedAttachVolume, …); "" while simply booting. */
  reason: string;
  /** How long the pod has been unready; 0 until a pod exists. */
  unreadySeconds: number;
};

let csrfToken = "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.method && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    window.location.href = "/auth/login?redirect_to=" + encodeURIComponent(window.location.pathname + window.location.search);
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // API errors are {"error": "..."} — surface the message, not the JSON.
    let msg = raw;
    try {
      msg = JSON.parse(raw).error || raw;
    } catch {
      /* not JSON */
    }
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const path = (name: string) => `/api/v1/workspaces/${encodeURIComponent(name)}`;

export async function fetchMe(): Promise<Me> {
  const me = await request<Me>("/api/v1/me");
  csrfToken = me.csrfToken;
  return me;
}

export const fetchWorkspaces = () => request<Workspace[]>("/api/v1/workspaces");

// postgres is omitted on purpose: the manager defaults it to true.
export const createWorkspace = (name: string) =>
  request<{ name: string }>("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const startWorkspace = (name: string) => request<void>(`${path(name)}/start`, { method: "POST" });

export const stopWorkspace = (name: string) => request<void>(`${path(name)}/stop`, { method: "POST" });

export const deleteWorkspace = (name: string) => request<void>(path(name), { method: "DELETE" });

export const workspaceStatus = (name: string) => request<WorkspaceStatus>(`${path(name)}/status`);
