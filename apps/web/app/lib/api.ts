import { useAuth } from "./auth";

export const API_BASE = "http://localhost:3001";

const authPaths = ["/api/auth/login", "/api/auth/register", "/api/auth/refresh"];

/**
 * fetch wrapper that attaches the bearer access token and transparently
 * retries once on 401 via the refresh token. If the refresh fails too, the
 * auth store is cleared and the next render redirects to /login.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const isPublicAuth = authPaths.includes(path);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (!isPublicAuth) {
    const token = useAuth.getState().accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  let res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401 && !isPublicAuth) {
    // Attempt single transparent refresh.
    const refreshToken = useAuth.getState().refreshToken;
    if (refreshToken) {
      const ok = await tryRefresh(refreshToken);
      if (ok) {
        const newToken = useAuth.getState().accessToken;
        if (newToken) headers["Authorization"] = `Bearer ${newToken}`;
        res = await fetch(`${API_BASE}${path}`, { ...init, headers });
      }
    }
    if (res.status === 401) {
      useAuth.getState().clear();
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      }
    }
  }

  if (!res.ok) {
    const body = await res.text();
    // Attach the parsed JSON body when possible — callers can read e.body for
    // structured error fields (e.g. APPROVAL_REQUIRED's pendingReviewIds)
    // without having to re-parse the message string.
    const err = new Error(`${res.status} ${res.statusText}: ${body}`) as ApiError;
    err.status = res.status;
    err.body = safeJson(body);
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface ApiError extends Error {
  status?: number;
  body?: any;
}
function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

async function tryRefresh(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const d = await res.json();
    useAuth.getState().setSession(d.accessToken, d.refreshToken, d.user);
    return true;
  } catch {
    return false;
  }
}

export function formatMoney(cents: number | string, currency = "USD") {
  const n = typeof cents === "string" ? Number(cents) : cents;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(n / 100);
}

/**
 * Download a file from an authed endpoint. Plain `<a href="/api/...">` won't
 * work under JWT auth because navigation doesn't carry the Authorization
 * header — the response is 401, which the browser surfaces as a failed
 * download. This fetches with the bearer token, then triggers a save via a
 * blob URL.
 */
export async function downloadFile(path: string, suggestedFilename?: string): Promise<void> {
  const token = useAuth.getState().accessToken;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }

  let filename = suggestedFilename;
  if (!filename) {
    const cd = res.headers.get("content-disposition") ?? "";
    const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
    if (m) filename = decodeURIComponent(m[1].trim());
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Open an authed HTML view (receipts, tax invoices) in a new tab. Same JWT
 * problem as `downloadFile` — `window.open(/api/...)` strips the bearer
 * header. Fetches the HTML, wraps in a blob URL, opens that.
 */
export async function openAuthed(path: string): Promise<void> {
  const token = useAuth.getState().accessToken;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Stable per-browser user id for session ownership (until real auth ships).
export function getDevUserId(): string {
  if (typeof window === "undefined") return "00000000-0000-0000-0000-000000000000";
  const KEY = "pos:dev-user-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
