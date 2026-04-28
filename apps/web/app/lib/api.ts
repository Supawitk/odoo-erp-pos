export const API_BASE = "http://localhost:3001";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
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
