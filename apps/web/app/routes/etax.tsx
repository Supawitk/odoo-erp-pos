import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { CheckCircle2, XCircle, Clock, AlertCircle, RotateCcw, Trash2, Lock, RefreshCw, Download } from "lucide-react";
import { api } from "~/lib/api";
import { useT } from "~/hooks/use-t";
import { useAuth } from "~/lib/auth";

/**
 * 🇹🇭 e-Tax submissions operator dashboard (Phase 4B Stage 2).
 *
 * One stop for the merchant's accountant or admin to:
 *   1. See queue health at a glance (counts by status)
 *   2. Filter the submission list by status / provider
 *   3. Run the relay drain on demand
 *   4. Requeue rejected/DLQ rows
 *   5. Mark a row DLQ manually (e.g. invoice was voided in RD portal)
 *   6. Download stored XML for forensic inspection
 *
 * Auto-refreshes every 15s — short enough to feel live without spamming the API.
 */

interface SubmissionRow {
  id: string;
  orderId: string;
  documentType: string;
  documentNumber: string;
  etdaCode: string;
  provider: string;
  status: "pending" | "submitted" | "acknowledged" | "rejected" | "dlq";
  attempts: number;
  lastError: string | null;
  rdReference: string | null;
  providerReference: string | null;
  ackTimestamp: string | null;
  nextAttemptAt: string | null;
  createdAt: string | null;
  xmlHash: string;
}

interface Stats {
  pending: number;
  submitted: number;
  acknowledged: number;
  rejected: number;
  dlq: number;
}

const STATUS_TONE: Record<SubmissionRow["status"], string> = {
  pending: "bg-amber-50 text-amber-900 border-amber-200",
  submitted: "bg-sky-50 text-sky-900 border-sky-200",
  acknowledged: "bg-emerald-50 text-emerald-900 border-emerald-200",
  rejected: "bg-rose-50 text-rose-900 border-rose-200",
  dlq: "bg-zinc-100 text-zinc-900 border-zinc-300",
};

const STATUS_ICON: Record<SubmissionRow["status"], React.ReactNode> = {
  pending: <Clock className="h-3.5 w-3.5" />,
  submitted: <RefreshCw className="h-3.5 w-3.5" />,
  acknowledged: <CheckCircle2 className="h-3.5 w-3.5" />,
  rejected: <XCircle className="h-3.5 w-3.5" />,
  dlq: <AlertCircle className="h-3.5 w-3.5" />,
};

const STATUS_LABELS: Record<SubmissionRow["status"], { en: string; th: string }> = {
  pending:      { en: "Pending",       th: "รอส่ง" },
  submitted:    { en: "In flight",     th: "กำลังส่ง" },
  acknowledged: { en: "Acknowledged",  th: "RD รับแล้ว" },
  rejected:     { en: "Rejected",      th: "ถูกปฏิเสธ" },
  dlq:          { en: "DLQ",           th: "เข้าคิวล้มเหลว" },
};

function StatusPill({ status }: { status: SubmissionRow["status"] }) {
  const isThai = typeof navigator !== "undefined" && navigator.language?.startsWith("th");
  const label = isThai ? STATUS_LABELS[status].th : STATUS_LABELS[status].en;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}
    >
      {STATUS_ICON[status]}
      {label}
    </span>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 0) {
    const future = Math.abs(diff);
    if (future < 60_000) return `in ${Math.round(future / 1000)}s`;
    if (future < 3_600_000) return `in ${Math.round(future / 60_000)}m`;
    return `in ${Math.round(future / 3_600_000)}h`;
  }
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return d.toISOString().slice(0, 10);
}

// Lightweight string lookup with fallback. Avoids bloating i18n.ts with 28
// keys that only this page uses; admins/accountants who flip country mode
// still see the EN fallbacks here.
function lookup(strings: Record<string, unknown>, key: string, fallback: string): string {
  const v = strings[key];
  return typeof v === "string" ? v : fallback;
}

export default function EtaxPage() {
  const strings = useT() as Record<string, unknown>;
  const t = (key: string, fallback: string) => lookup(strings, key, fallback);
  const { user, hydrated } = useAuth();
  const isAuthorised =
    user?.role === "admin" || user?.role === "accountant" || user?.role === "manager";
  const canMutate = user?.role === "admin" || user?.role === "accountant";

  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<SubmissionRow["status"] | "all">("all");
  const [providerFilter, setProviderFilter] = useState<"leceipt" | "inet" | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    if (!hydrated || !isAuthorised) return;
    try {
      const qs = new URLSearchParams();
      if (statusFilter !== "all") qs.set("status", statusFilter);
      if (providerFilter !== "all") qs.set("provider", providerFilter);
      qs.set("limit", "200");
      const [s, r] = await Promise.all([
        api<Stats>("/api/etax/stats"),
        api<SubmissionRow[]>(`/api/etax/submissions?${qs.toString()}`),
      ]);
      setStats(s);
      setRows(r);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? "load failed");
    }
  }

  useEffect(() => {
    if (!hydrated) return;
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [hydrated, isAuthorised, statusFilter, providerFilter]);

  async function runRelayNow() {
    if (!canMutate) return;
    setRunning(true);
    setErr(null);
    setInfo(null);
    try {
      const res = await api<{ attempted: number; succeeded: number; rejected: number; failed: number }>(
        "/api/etax/relay/run?batchSize=50",
        { method: "POST" },
      );
      setInfo(
        `drain complete: ${res.attempted} attempted, ${res.succeeded} ack, ${res.rejected} rejected, ${res.failed} retrying`,
      );
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "drain failed");
    } finally {
      setRunning(false);
    }
  }

  async function requeue(id: string) {
    setBusy(id);
    try {
      await api(`/api/etax/submissions/${id}/requeue`, { method: "POST" });
      setInfo(`requeued ${id.slice(0, 8)}`);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "requeue failed");
    } finally {
      setBusy(null);
    }
  }

  async function forceDlq(id: string, reason: string) {
    if (!reason.trim()) return;
    setBusy(id);
    try {
      await api(
        `/api/etax/submissions/${id}/dlq?reason=${encodeURIComponent(reason)}`,
        { method: "POST" },
      );
      setInfo(`flagged ${id.slice(0, 8)} as DLQ`);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "DLQ-mark failed");
    } finally {
      setBusy(null);
    }
  }

  function downloadXmlUrl(id: string): string {
    return `/api/etax/submissions/${id}/xml`;
  }

  if (!hydrated) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }

  if (!isAuthorised) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <Lock className="h-10 w-10 text-muted-foreground" />
        <h2 className="text-xl font-semibold">{t("etax_admin_only", "Admin / accountant only")}</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {t(
            "etax_admin_only_desc",
            "The e-Tax operator dashboard manages submissions to the Revenue Department via Leceipt or INET. Sign in as an admin, accountant, or manager.",
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("etax_title", "e-Tax submissions")}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "etax_subtitle",
              "Live queue for tax invoices being shipped to the Revenue Department via Leceipt + INET.",
            )}
          </p>
        </div>
        {canMutate ? (
          <Button onClick={runRelayNow} disabled={running} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
            {running ? t("etax_running", "Draining…") : t("etax_run_now", "Run relay now")}
          </Button>
        ) : null}
      </header>

      {err ? (
        <Card className="border-rose-300 bg-rose-50">
          <CardContent className="py-3 text-sm text-rose-900">{err}</CardContent>
        </Card>
      ) : null}
      {info ? (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="py-3 text-sm text-emerald-900">{info}</CardContent>
        </Card>
      ) : null}

      {/* Counts strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(["pending", "submitted", "acknowledged", "rejected", "dlq"] as const).map((k) => (
          <Card
            key={k}
            className={`cursor-pointer transition ${
              statusFilter === k ? "ring-2 ring-primary" : ""
            }`}
            onClick={() => setStatusFilter(statusFilter === k ? "all" : k)}
          >
            <CardContent className="space-y-1 p-4">
              <div className="text-xs text-muted-foreground">
                <StatusPill status={k} />
              </div>
              <div className="text-2xl font-bold">{stats?.[k] ?? 0}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">{t("etax_filter", "Filter:")}</span>
        <select
          className="rounded-md border bg-background px-2 py-1.5"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
        >
          <option value="all">{t("etax_all_statuses", "All statuses")}</option>
          <option value="pending">{t("etax_status_pending", "Pending")}</option>
          <option value="submitted">{t("etax_status_submitted", "In flight")}</option>
          <option value="acknowledged">{t("etax_status_acknowledged", "Acknowledged")}</option>
          <option value="rejected">{t("etax_status_rejected", "Rejected")}</option>
          <option value="dlq">{t("etax_status_dlq", "DLQ")}</option>
        </select>
        <select
          className="rounded-md border bg-background px-2 py-1.5"
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value as any)}
        >
          <option value="all">{t("etax_all_providers", "All providers")}</option>
          <option value="leceipt">Leceipt</option>
          <option value="inet">INET</option>
        </select>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("etax_auto_refresh", "auto-refresh 15s")}
        </span>
      </div>

      {/* Submissions table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("etax_submissions_count", `${rows.length} submissions`)}
          </CardTitle>
          <CardDescription>
            {t(
              "etax_submissions_desc",
              "Click 'Run relay now' to drain pending rows immediately. Backoff is 30s → 5m → 30m → 2h → 6h → DLQ.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              {t("etax_empty", "No submissions match the current filter.")}
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                  <tr className="text-left">
                    <th className="px-4 py-2 font-medium">{t("etax_doc", "Document")}</th>
                    <th className="px-4 py-2 font-medium">{t("etax_provider", "Provider")}</th>
                    <th className="px-4 py-2 font-medium">{t("etax_status", "Status")}</th>
                    <th className="px-4 py-2 font-medium">{t("etax_rd_ref", "RD ref")}</th>
                    <th className="px-4 py-2 font-medium">{t("etax_attempts", "Attempts")}</th>
                    <th className="px-4 py-2 font-medium">{t("etax_age", "Created")}</th>
                    <th className="px-4 py-2 font-medium">{t("etax_actions", "Actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t hover:bg-muted/30">
                      <td className="px-4 py-2">
                        <div className="font-mono text-xs font-medium">{r.documentNumber}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.documentType} · {r.etdaCode}
                        </div>
                      </td>
                      <td className="px-4 py-2 capitalize">{r.provider}</td>
                      <td className="px-4 py-2">
                        <div className="space-y-1">
                          <StatusPill status={r.status} />
                          {r.lastError ? (
                            <div className="max-w-[280px] truncate text-xs text-muted-foreground" title={r.lastError}>
                              {r.lastError}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {r.rdReference ?? <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2 text-center">{r.attempts}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {relativeTime(r.createdAt)}
                        {r.nextAttemptAt && r.status === "pending" ? (
                          <div>next: {relativeTime(r.nextAttemptAt)}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          <a
                            href={downloadXmlUrl(r.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                            title={t("etax_download_xml", "Download stored XML")}
                          >
                            <Download className="h-3.5 w-3.5" />
                            XML
                          </a>
                          {canMutate && (r.status === "rejected" || r.status === "dlq") ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === r.id}
                              onClick={() => requeue(r.id)}
                              className="gap-1"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              {t("etax_requeue", "Requeue")}
                            </Button>
                          ) : null}
                          {user?.role === "admin" && r.status !== "dlq" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy === r.id}
                              onClick={() => {
                                const reason = window.prompt(
                                  t("etax_dlq_reason", "Reason for forcing DLQ?"),
                                );
                                if (reason && reason.trim()) forceDlq(r.id, reason.trim());
                              }}
                              className="gap-1 text-rose-700 hover:bg-rose-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              DLQ
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Help footer */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("etax_help_title", "How this works")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            {t(
              "etax_help_1",
              "Every paid TX/ABB/CN/DN order is auto-queued for submission to RD via Leceipt (primary). The relay drains the queue every minute.",
            )}
          </p>
          <p>
            {t(
              "etax_help_2",
              "Pending rows retry on transient errors (network/5xx) with exponential backoff. After 5 attempts they move to DLQ for manual review.",
            )}
          </p>
          <p>
            {t(
              "etax_help_3",
              "Rejected = the ASP/RD said the document is malformed. Don't requeue without fixing the underlying order — it'll just reject again.",
            )}
          </p>
          <p>
            {t(
              "etax_help_4",
              "DLQ = ran out of retry budget OR was force-flagged by an admin. Investigate the lastError, fix the data, then requeue.",
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
