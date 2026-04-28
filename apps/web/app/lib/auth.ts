import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "admin" | "manager" | "accountant" | "cashier";

export interface AuthUser {
  id: string;
  email: string | null;
  username: string | null;
  name: string;
  role: Role;
  isActive: boolean;
}

/** Display label for the user in the UI — prefers username, falls back to email. */
export function authIdentity(u: { username?: string | null; email?: string | null }): string {
  return u.username ?? u.email ?? "(no identity)";
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  hydrated: boolean;
  setSession: (
    accessToken: string,
    refreshToken: string,
    user: AuthUser,
  ) => void;
  setUser: (user: AuthUser) => void;
  clear: () => void;
}

/**
 * Persisted across reloads in localStorage. SSR-safe: store starts empty on
 * the server; the layout reads `hydrated` to know when client-side data is
 * ready before deciding whether to redirect to /login.
 */
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      hydrated: false,
      setSession: (accessToken, refreshToken, user) =>
        set({ accessToken, refreshToken, user }),
      setUser: (user) => set({ user }),
      clear: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    { name: "erp-auth" },
  ),
);

// Hydration flag has to be set after persist middleware has loaded from
// localStorage. The persist middleware finishes synchronously on the client;
// flipping `hydrated=true` after a microtask ensures any consumers running
// during render still see the rehydrated values.
if (typeof window !== "undefined") {
  queueMicrotask(() => {
    useAuth.setState({ hydrated: true });
  });
}
