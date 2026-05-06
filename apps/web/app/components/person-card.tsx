/**
 * PersonCard — a consistent, clickable card used wherever a "person" appears
 * across the site (branch detail, approvals, user lists, etc.).
 *
 * Clicking the card opens a PersonProfileModal with full details.
 */
import { useState } from "react";
import { X, Clock, Calendar, Building2 } from "lucide-react";
import type { Role } from "~/lib/auth";

export interface PersonData {
  id: string;
  name: string;
  email: string | null;
  username: string | null;
  role: Role | string;
  isActive: boolean;
  branchCode?: string | null;
  lastLoginAt?: string | null;
  createdAt?: string | null;
}

// ─── Role helpers ─────────────────────────────────────────────────────────────

const ROLE_CONFIG: Record<string, { label: string; bg: string; text: string; ring: string }> = {
  admin: {
    label: "Admin",
    bg: "bg-violet-100",
    text: "text-violet-700",
    ring: "bg-violet-500",
  },
  manager: {
    label: "Manager",
    bg: "bg-blue-100",
    text: "text-blue-700",
    ring: "bg-blue-500",
  },
  accountant: {
    label: "Accountant",
    bg: "bg-emerald-100",
    text: "text-emerald-700",
    ring: "bg-emerald-500",
  },
  cashier: {
    label: "Cashier",
    bg: "bg-amber-100",
    text: "text-amber-700",
    ring: "bg-amber-500",
  },
};

function roleConfig(role: string) {
  return ROLE_CONFIG[role] ?? { label: role, bg: "bg-slate-100", text: "text-slate-600", ring: "bg-slate-400" };
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarRing(role: string) {
  return roleConfig(role).ring;
}

function formatTs(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── PersonCard ───────────────────────────────────────────────────────────────

/**
 * Self-contained card: clicking opens the profile modal.
 *
 * Controlled mode: pass `_forceOpen={true}` and `onCloseForced` to drive
 * the modal from outside (e.g. from a table row without the card UI).
 */
export function PersonCard({
  person,
  _forceOpen,
  onCloseForced,
}: {
  person: PersonData;
  _forceOpen?: boolean;
  onCloseForced?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rc = roleConfig(person.role);

  // Controlled mode: just render the modal, no card
  if (_forceOpen) {
    return (
      <PersonProfileModal
        person={person}
        onClose={() => onCloseForced?.()}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          "group flex w-full flex-col gap-2 rounded-xl border bg-card p-4 text-left shadow-sm " +
          "transition hover:shadow-md hover:border-primary/40 focus-visible:outline-none " +
          "focus-visible:ring-2 focus-visible:ring-primary " +
          (!person.isActive ? "opacity-60" : "")
        }
      >
        {/* Avatar + name row */}
        <div className="flex items-center gap-3">
          <div
            className={
              "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white " +
              avatarRing(person.role)
            }
          >
            {initials(person.name)}
            {/* Active indicator dot */}
            <span
              className={
                "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-card " +
                (person.isActive ? "bg-green-500" : "bg-slate-300")
              }
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold leading-tight text-foreground group-hover:text-primary">
              {person.name}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {person.email ?? person.username ?? "—"}
            </p>
          </div>
        </div>

        {/* Role badge */}
        <span
          className={`inline-flex self-start rounded-full px-2 py-0.5 text-[11px] font-medium ${rc.bg} ${rc.text}`}
        >
          {rc.label}
        </span>
      </button>

      {open && <PersonProfileModal person={person} onClose={() => setOpen(false)} />}
    </>
  );
}

// ─── PersonProfileModal ───────────────────────────────────────────────────────

function PersonProfileModal({
  person,
  onClose,
}: {
  person: PersonData;
  onClose: () => void;
}) {
  const rc = roleConfig(person.role);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm rounded-2xl bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header strip */}
        <div className={`rounded-t-2xl px-6 py-5 ${rc.bg}`}>
          <button
            type="button"
            onClick={onClose}
            className={`absolute right-4 top-4 rounded-full p-1 ${rc.text} opacity-70 hover:opacity-100`}
          >
            <X className="h-4 w-4" />
          </button>

          <div className="flex items-center gap-4">
            <div
              className={
                "flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-xl font-bold text-white shadow " +
                avatarRing(person.role)
              }
            >
              {initials(person.name)}
            </div>
            <div>
              <p className={`text-lg font-bold ${rc.text}`}>{person.name}</p>
              <span
                className={`mt-0.5 inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${rc.bg} ${rc.text} border border-current/20`}
              >
                {rc.label}
              </span>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="divide-y px-6 py-4 text-sm">
          <Row label="Email">{person.email ?? <Muted>—</Muted>}</Row>
          <Row label="Username">{person.username ?? <Muted>—</Muted>}</Row>
          <Row label="Status">
            <span
              className={
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium " +
                (person.isActive
                  ? "bg-green-100 text-green-700"
                  : "bg-slate-100 text-slate-500")
              }
            >
              <span
                className={
                  "h-1.5 w-1.5 rounded-full " +
                  (person.isActive ? "bg-green-500" : "bg-slate-400")
                }
              />
              {person.isActive ? "Active" : "Inactive"}
            </span>
          </Row>
          {person.branchCode && (
            <Row label="Branch">
              <span className="flex items-center gap-1 font-mono">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                {person.branchCode === "00000" ? "Head Office" : person.branchCode}
              </span>
            </Row>
          )}
          <Row label="Last login">
            <span className="flex items-center gap-1 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {formatTs(person.lastLoginAt)}
            </span>
          </Row>
          <Row label="Member since">
            <span className="flex items-center gap-1 text-muted-foreground">
              <Calendar className="h-3.5 w-3.5" />
              {formatTs(person.createdAt)}
            </span>
          </Row>
        </div>

        <div className="rounded-b-2xl px-6 pb-5 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg border py-2 text-sm text-muted-foreground hover:bg-muted"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}
