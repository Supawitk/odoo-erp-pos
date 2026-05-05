import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";

// Lightweight badge — the project doesn't have shadcn's Badge yet, so inline.
function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: "default" | "outline" | "secondary" }) {
  const cls = variant === "outline"
    ? "border border-border text-foreground"
    : variant === "secondary"
    ? "bg-muted text-muted-foreground"
    : "bg-primary text-primary-foreground";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}
import { CheckCircle2, XCircle, Clock, AlertCircle, ExternalLink } from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import { useT } from "~/hooks/use-t";

interface PendingReview {
  review: {
    id: string;
    targetKind: "pos.refund" | "po.confirm" | "accounting.je";
    targetId: string;
    status: string;
    requestedAt: string;
    payload: Record<string, unknown>;
    requesterComment: string | null;
  };
  definition: {
    id: string;
    name: string;
    targetKind: string;
    conditionExpr: string | null;
    sequence: number;
  } | null;
  requesterEmail: string | null;
  requesterName: string | null;
}

const KIND_LABELS: Record<PendingReview["review"]["targetKind"], { en: string; th: string }> = {
  "pos.refund":     { en: "Refund",            th: "คืนเงิน" },
  "po.confirm":     { en: "Purchase Order",    th: "ใบสั่งซื้อ" },
  "accounting.je":  { en: "Manual Journal",    th: "บันทึกบัญชี" },
};

/**
 * Map a tier-review (kind, targetId) to the page that owns the source doc.
 * Returns null for kinds where the target doesn't yet exist as a persisted
 * row (manual JEs are gated BEFORE insert, so /accounting can't find them).
 * In that case the inbox card renders an inline preview from the payload
 * instead of a deep-link.
 */
function deepLinkFor(kind: PendingReview["review"]["targetKind"], targetId: string): string | null {
  switch (kind) {
    case "pos.refund":     return `/pos?focusOrder=${encodeURIComponent(targetId)}`;
    case "po.confirm":     return `/inventory?tab=purchasing&focusPo=${encodeURIComponent(targetId)}`;
    case "accounting.je":  return null; // unposted — show inline preview
  }
}

/**
 * For accounting.je reviews, the payload carries the proposed lines so the
 * approver can see exactly what mutation they're signing off on.
 */
interface JeLinePreview {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  description: string | null;
}
function getJePreview(payload: Record<string, unknown>): {
  date?: string;
  description?: string;
  reference?: string | null;
  lines: JeLinePreview[];
} | null {
  const lines = (payload.lines as JeLinePreview[] | undefined) ?? null;
  if (!Array.isArray(lines)) return null;
  return {
    date: payload.date as string | undefined,
    description: payload.description as string | undefined,
    reference: (payload.reference as string | null | undefined) ?? null,
    lines,
  };
}

export default function ApprovalsPage() {
  const t = useT();
  const [rows, setRows] = useState<PendingReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const isThai = (typeof navigator !== "undefined" && navigator.language?.startsWith("th"));

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const data = await api<PendingReview[]>("/api/approvals");
      setRows(data);
    } catch (e: any) {
      setError(e?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function approve(id: string) {
    setBusy(id);
    try {
      await api(`/api/approvals/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ comment: comment || undefined }),
      });
      setComment("");
      await load();
    } catch (e: any) {
      setError(e?.message ?? "approve failed");
    } finally {
      setBusy(null);
    }
  }

  async function reject(id: string) {
    if (!comment.trim()) {
      setError(isThai ? "ต้องระบุเหตุผลในการปฏิเสธ" : "rejection requires a comment");
      return;
    }
    setBusy(id);
    try {
      await api(`/api/approvals/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ comment }),
      });
      setComment("");
      setRejectFor(null);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "reject failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {isThai ? "รออนุมัติ" : "Approvals"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isThai
              ? "รายการที่ต้องการให้คุณตรวจสอบก่อนเดินเอกสารต่อ"
              : "Items waiting for your sign-off before they can proceed."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={rows.length > 0 ? "default" : "secondary"}>
            <Clock className="mr-1 h-3 w-3" />
            {rows.length} {isThai ? "รายการ" : "pending"}
          </Badge>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {isThai ? "รีเฟรช" : "Refresh"}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {error}
          </CardContent>
        </Card>
      )}

      {loading && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{isThai ? "กำลังโหลด…" : "Loading…"}</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-500" />
            <p className="text-lg font-medium">
              {isThai ? "ไม่มีอะไรรออยู่" : "All clear"}
            </p>
            <p className="text-sm text-muted-foreground">
              {isThai
                ? "ทุกรายการได้รับการอนุมัติเรียบร้อย"
                : "Nothing in your queue right now."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const k = r.review.targetKind;
            const label = isThai ? KIND_LABELS[k]?.th : KIND_LABELS[k]?.en;
            const amount = Number(r.review.payload?.amount ?? 0);
            const currency = String(r.review.payload?.currency ?? "THB");
            const isRejecting = rejectFor === r.review.id;
            const link = deepLinkFor(k, r.review.targetId);
            const jePreview = k === "accounting.je" ? getJePreview(r.review.payload ?? {}) : null;
            return (
              <Card key={r.review.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="flex items-center gap-2">
                        <Badge variant="outline">{label}</Badge>
                        {link ? (
                          <Link
                            to={link}
                            className="group inline-flex items-center gap-1 font-mono text-sm text-muted-foreground hover:text-primary"
                            title={isThai ? "เปิดเอกสารต้นทาง" : "Open source document"}
                          >
                            #{r.review.targetId.slice(0, 12)}
                            <ExternalLink className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                          </Link>
                        ) : (
                          <span
                            className="font-mono text-sm text-muted-foreground"
                            title={isThai ? "ยังไม่ผ่าน — ดูรายละเอียดด้านล่าง" : "not posted yet — see preview below"}
                          >
                            #{r.review.targetId.slice(0, 12)}
                          </span>
                        )}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {r.definition?.name ?? "(rule deleted)"}
                        {r.definition?.conditionExpr && (
                          <span className="ml-2 font-mono text-xs">
                            ({r.definition.conditionExpr})
                          </span>
                        )}
                      </CardDescription>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-semibold tabular-nums">
                        {formatMoney(amount, currency)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(r.review.requestedAt).toLocaleString(isThai ? "th-TH" : "en-US")}
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {r.requesterEmail && (
                    <div className="text-xs text-muted-foreground">
                      {isThai ? "ยื่นโดย" : "requested by"}: {r.requesterName ?? r.requesterEmail}
                    </div>
                  )}
                  {r.review.requesterComment && (
                    <div className="rounded bg-muted px-3 py-2 text-sm italic">
                      "{r.review.requesterComment}"
                    </div>
                  )}

                  {jePreview && jePreview.lines.length > 0 && (
                    <div className="rounded border bg-muted/30 p-3 text-xs">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-semibold">
                          {isThai ? "รายการบัญชีที่จะลงบันทึก" : "Proposed ledger entries"}
                        </span>
                        <span className="text-muted-foreground">
                          {jePreview.date}
                          {jePreview.reference ? ` · ${jePreview.reference}` : ""}
                        </span>
                      </div>
                      <table className="w-full">
                        <thead>
                          <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                            <th className="py-1 text-left">{isThai ? "บัญชี" : "Account"}</th>
                            <th className="py-1 text-right">{isThai ? "เดบิต" : "Debit"}</th>
                            <th className="py-1 text-right">{isThai ? "เครดิต" : "Credit"}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {jePreview.lines.map((l, i) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="py-1">
                                <span className="font-mono">{l.accountCode}</span>{" "}
                                <span className="text-muted-foreground">{l.accountName}</span>
                                {l.description && (
                                  <span className="ml-1 text-muted-foreground">— {l.description}</span>
                                )}
                              </td>
                              <td className="py-1 text-right tabular-nums">
                                {l.debitCents > 0 ? formatMoney(l.debitCents, currency) : ""}
                              </td>
                              <td className="py-1 text-right tabular-nums">
                                {l.creditCents > 0 ? formatMoney(l.creditCents, currency) : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {isThai
                          ? "หมายเหตุ: เมื่ออนุมัติแล้ว ผู้ส่งคำขอต้องส่งคำขอบันทึกใหม่อีกครั้งจึงจะลงบัญชีจริง"
                          : "Note: after approval, the original submitter must resubmit to actually post."}
                      </p>
                    </div>
                  )}

                  {isRejecting ? (
                    <div className="space-y-2">
                      <Input
                        autoFocus
                        placeholder={isThai ? "เหตุผลในการปฏิเสธ (จำเป็น)" : "Rejection reason (required)"}
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={!comment.trim() || busy === r.review.id}
                          onClick={() => reject(r.review.id)}
                        >
                          <XCircle className="mr-1 h-4 w-4" />
                          {isThai ? "ยืนยันปฏิเสธ" : "Confirm reject"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setRejectFor(null); setComment(""); }}
                        >
                          {isThai ? "ยกเลิก" : "Cancel"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder={isThai ? "หมายเหตุ (ไม่บังคับ)" : "Optional comment"}
                        value={busy === r.review.id ? "" : comment}
                        onChange={(e) => setComment(e.target.value)}
                        className="h-9 max-w-md"
                      />
                      <Button
                        size="sm"
                        disabled={busy === r.review.id}
                        onClick={() => approve(r.review.id)}
                      >
                        <CheckCircle2 className="mr-1 h-4 w-4" />
                        {isThai ? "อนุมัติ" : "Approve"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === r.review.id}
                        onClick={() => { setRejectFor(r.review.id); setComment(""); }}
                      >
                        <XCircle className="mr-1 h-4 w-4" />
                        {isThai ? "ปฏิเสธ" : "Reject"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

void useT;
