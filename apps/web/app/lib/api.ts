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
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
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
