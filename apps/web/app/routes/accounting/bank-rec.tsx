import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { CheckCircle2, ChevronRight, Loader2, Plus } from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import { useCashAccounts } from "~/hooks/use-cash-accounts";
import type { BankStatement, BankLine, Suggestion } from "./types";

export function BankRecTab({ currency, useThai }: { currency: string; useThai: boolean }) {
  const [statements, setStatements] = useState<BankStatement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const rows = await api<BankStatement[]>(`/api/bank-rec/statements`);
      setStatements(rows);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-end justify-between">
          <div>
            <CardTitle>{useThai ? "กระทบยอดธนาคาร" : "Bank reconciliation"}</CardTitle>
            <CardDescription>
              {useThai
                ? "นำเข้าใบแจ้งยอดธนาคาร จับคู่กับรายการทางบัญชีอัตโนมัติ ยืนยันด้วยตนเอง"
                : "Import bank statements (OFX/CSV), auto-suggest matches against posted journal entries, confirm manually."}
            </CardDescription>
          </div>
          <Button onClick={() => setImportOpen(true)} className="h-10">
            <Plus className="h-4 w-4" />
            {useThai ? "นำเข้าใบแจ้งยอด" : "Import statement"}
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
          {err && (
            <p className="px-4 text-sm text-destructive">{err}</p>
          )}
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : statements.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              {useThai ? "ยังไม่มีใบแจ้งยอด" : "No statements imported yet."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">{useThai ? "ธนาคาร" : "Bank"}</th>
                  <th className="px-4 py-2">{useThai ? "บัญชี" : "Account"}</th>
                  <th className="px-4 py-2">{useThai ? "ช่วงเวลา" : "Period"}</th>
                  <th className="px-4 py-2 text-right">{useThai ? "ยังไม่จับคู่" : "Unmatched"}</th>
                  <th className="px-4 py-2 text-right">{useThai ? "จับคู่แล้ว" : "Matched"}</th>
                  <th className="px-4 py-2 text-right">{useThai ? "ละเว้น" : "Ignored"}</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {statements.map((s) => (
                  <tr
                    key={s.id}
                    className={
                      "border-b last:border-0 cursor-pointer " +
                      (selectedId === s.id ? "bg-muted/40" : "hover:bg-muted/40")
                    }
                    onClick={() => setSelectedId(s.id === selectedId ? null : s.id)}
                  >
                    <td className="px-4 py-2">{s.bankLabel}</td>
                    <td className="px-4 py-2 font-mono text-xs">{s.cashAccountCode}</td>
                    <td className="px-4 py-2 text-xs">
                      {s.statementFrom ?? "—"} → {s.statementTo ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {s.counts.unmatched > 0 ? (
                        <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700">
                          {s.counts.unmatched}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {s.counts.matched > 0 ? (
                        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-700">
                          {s.counts.matched}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {s.counts.ignored > 0 ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs">
                          {s.counts.ignored}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <ChevronRight
                        className={
                          "h-4 w-4 inline transition-transform " +
                          (selectedId === s.id ? "rotate-90" : "")
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {selectedId && (
        <BankStatementLines
          statementId={selectedId}
          currency={currency}
          useThai={useThai}
          onChanged={reload}
        />
      )}

      {importOpen && (
        <ImportStatementDialog
          useThai={useThai}
          onClose={() => setImportOpen(false)}
          onImported={async (newId) => {
            setImportOpen(false);
            await reload();
            setSelectedId(newId);
          }}
        />
      )}
    </div>
  );
}

function BankStatementLines({
  statementId,
  currency,
  useThai,
  onChanged,
}: {
  statementId: string;
  currency: string;
  useThai: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [data, setData] = useState<{ statement: any; lines: BankLine[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeLine, setActiveLine] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const d = await api<{ statement: any; lines: BankLine[] }>(
        `/api/bank-rec/statements/${statementId}/lines`,
      );
      setData(d);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statementId]);

  const unmatch = async (id: string) => {
    if (!confirm(useThai ? "ยกเลิกการจับคู่?" : "Unmatch this line?")) return;
    try {
      await api(`/api/bank-rec/lines/${id}/unmatch`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await reload();
      await onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const ignoreLine = async (id: string) => {
    const reason = prompt(useThai ? "เหตุผลการละเว้น (≥3 ตัวอักษร):" : "Ignore reason (≥3 chars):");
    if (!reason || reason.trim().length < 3) return;
    try {
      await api(`/api/bank-rec/lines/${id}/ignore`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      await reload();
      await onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <Card className="border-2">
      <CardHeader>
        <CardTitle className="text-base">
          {data?.statement?.bankLabel ?? "…"}{" "}
          <span className="text-muted-foreground font-mono text-xs">
            ({data?.statement?.cashAccountCode})
          </span>
        </CardTitle>
        <CardDescription>
          {useThai
            ? "คลิก 'แนะนำ' เพื่อดูรายการที่อาจตรงกัน — ตรวจสอบแล้วยืนยันการจับคู่"
            : "Click 'Suggest' to see candidates — review and confirm the match."}
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        {err && <p className="px-4 text-sm text-destructive">{err}</p>}
        {loading || !data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">{useThai ? "วันที่" : "Date"}</th>
                <th className="px-3 py-2">{useThai ? "รายละเอียด" : "Description"}</th>
                <th className="px-3 py-2">{useThai ? "อ้างอิง" : "Ref"}</th>
                <th className="px-3 py-2 text-right">{useThai ? "ยอด" : "Amount"}</th>
                <th className="px-3 py-2">{useThai ? "สถานะ" : "Status"}</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="px-3 py-2 text-xs text-muted-foreground">{l.lineNo}</td>
                  <td className="px-3 py-2">{l.postedAt}</td>
                  <td className="px-3 py-2 text-xs">{l.description ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.bankRef ?? "—"}</td>
                  <td
                    className={
                      "px-3 py-2 text-right tabular-nums " +
                      (l.amountCents > 0 ? "text-emerald-700" : "text-rose-700")
                    }
                  >
                    {formatMoney(l.amountCents, currency)}
                  </td>
                  <td className="px-3 py-2">
                    <BankLineStatusPill status={l.status} useThai={useThai} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {l.status === "unmatched" && (
                      <div className="inline-flex gap-1">
                        <button
                          type="button"
                          className="text-[10px] uppercase tracking-wide text-primary hover:underline"
                          onClick={() => setActiveLine(l.id)}
                        >
                          {useThai ? "แนะนำ" : "suggest"}
                        </button>
                        <span className="text-muted-foreground">·</span>
                        <button
                          type="button"
                          className="text-[10px] uppercase tracking-wide text-muted-foreground hover:underline"
                          onClick={() => ignoreLine(l.id)}
                        >
                          {useThai ? "ละเว้น" : "ignore"}
                        </button>
                      </div>
                    )}
                    {l.status === "matched" && (
                      <button
                        type="button"
                        className="text-[10px] uppercase tracking-wide text-rose-600 hover:underline"
                        onClick={() => unmatch(l.id)}
                      >
                        {useThai ? "ยกเลิกจับคู่" : "unmatch"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {activeLine && (
        <SuggestMatchDialog
          lineId={activeLine}
          line={data?.lines.find((l) => l.id === activeLine) ?? null}
          currency={currency}
          useThai={useThai}
          onClose={() => setActiveLine(null)}
          onMatched={async () => {
            setActiveLine(null);
            await reload();
            await onChanged();
          }}
        />
      )}
    </Card>
  );
}

function BankLineStatusPill({
  status,
  useThai,
}: {
  status: BankLine["status"];
  useThai: boolean;
}) {
  const map: Record<
    BankLine["status"],
    { cls: string; label: string }
  > = {
    unmatched: {
      cls: "bg-amber-500/15 text-amber-700",
      label: useThai ? "ยังไม่จับคู่" : "unmatched",
    },
    matched: {
      cls: "bg-emerald-500/15 text-emerald-700",
      label: useThai ? "จับคู่แล้ว" : "matched",
    },
    ignored: { cls: "bg-muted text-muted-foreground", label: useThai ? "ละเว้น" : "ignored" },
  };
  const m = map[status] ?? map.unmatched;
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

function SuggestMatchDialog({
  lineId,
  line,
  currency,
  useThai,
  onClose,
  onMatched,
}: {
  lineId: string;
  line: BankLine | null;
  currency: string;
  useThai: boolean;
  onClose: () => void;
  onMatched: () => Promise<void> | void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(7);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<Suggestion[]>(`/api/bank-rec/lines/${lineId}/suggestions?dateWindowDays=${windowDays}`)
      .then((s) => !cancelled && setSuggestions(s))
      .catch((e) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [lineId, windowDays]);

  const confirm = async (jeId: string, jeAmount: number) => {
    if (!line) return;
    if (line.amountCents !== jeAmount) {
      setErr(
        useThai
          ? `ยอดไม่ตรง: ใบแจ้งยอด ${line.amountCents} ≠ JE ${jeAmount}`
          : `Amount mismatch: bank ${line.amountCents} ≠ JE ${jeAmount}. Pick a candidate that matches exactly.`,
      );
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/bank-rec/lines/${lineId}/match`, {
        method: "POST",
        body: JSON.stringify({
          links: [{ journalEntryId: jeId, amountCents: jeAmount }],
        }),
      });
      await onMatched();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-2xl max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <CardTitle>{useThai ? "แนะนำการจับคู่" : "Suggested matches"}</CardTitle>
          <CardDescription>
            {line
              ? `${line.postedAt} · ${formatMoney(line.amountCents, currency)} · ${
                  line.description ?? ""
                }`
              : ""}
          </CardDescription>
          <div className="flex items-center gap-2 pt-2">
            <label className="text-xs text-muted-foreground">
              {useThai ? "ช่วงวันที่" : "Date window"}
            </label>
            <Input
              type="number"
              min={1}
              max={60}
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value) || 7)}
              className="h-8 w-20"
            />
            <span className="text-xs text-muted-foreground">{useThai ? "วัน" : "days"}</span>
          </div>
        </CardHeader>
        <CardContent>
          {err && <p className="text-sm text-destructive">{err}</p>}
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : suggestions.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              {useThai
                ? "ไม่พบรายการที่อาจตรงกันในช่วงเวลานี้ — ลองขยายช่วงวันที่"
                : "No candidates in this window — try widening the date range."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1">{useThai ? "คะแนน" : "Score"}</th>
                  <th className="py-1">{useThai ? "วันที่" : "Date"}</th>
                  <th className="py-1">{useThai ? "อ้างอิง" : "Reference"}</th>
                  <th className="py-1 text-right">{useThai ? "ยอด" : "Amount"}</th>
                  <th className="py-1">{useThai ? "เหตุผล" : "Reasons"}</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => (
                  <tr key={s.candidate.id} className="border-b last:border-0">
                    <td className="py-1 font-mono">
                      <span
                        className={
                          s.score >= 90
                            ? "text-emerald-700 font-bold"
                            : s.score >= 70
                            ? "text-emerald-600"
                            : "text-amber-700"
                        }
                      >
                        {s.score}
                      </span>
                    </td>
                    <td className="py-1">{s.candidate.date}</td>
                    <td className="py-1 text-xs">
                      {s.candidate.reference ?? s.candidate.description ?? "—"}
                      {s.candidate.sourceModule && (
                        <span className="ml-1 text-muted-foreground">
                          [{s.candidate.sourceModule}]
                        </span>
                      )}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {formatMoney(s.candidate.amountCents, currency)}
                    </td>
                    <td className="py-1 text-xs text-muted-foreground">
                      {s.reasons.join(" · ")}
                    </td>
                    <td className="py-1 text-right">
                      <Button
                        size="sm"
                        variant={s.score >= 90 ? "default" : "outline"}
                        onClick={() =>
                          confirm(s.candidate.id, s.candidate.amountCents)
                        }
                        disabled={busy}
                        className="h-7"
                      >
                        {busy ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3" />
                        )}
                        {useThai ? "จับคู่" : "match"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ImportStatementDialog({
  useThai,
  onClose,
  onImported,
}: {
  useThai: boolean;
  onClose: () => void;
  onImported: (id: string) => Promise<void> | void;
}) {
  const { accounts: cashAccounts, primaryCode } = useCashAccounts();
  const [cashAccount, setCashAccount] = useState<string>(primaryCode);
  useEffect(() => {
    if (cashAccounts.length > 0 && !cashAccounts.some((a) => a.code === cashAccount)) {
      setCashAccount(primaryCode);
    }
  }, [cashAccounts, primaryCode]);
  const [bankLabel, setBankLabel] = useState("");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFilename(f.name);
    f.text().then(setContent);
  };

  const submit = async () => {
    if (!content.trim()) {
      setErr(useThai ? "ไม่มีไฟล์" : "Pick a file or paste content");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ statementId: string; linesInserted: number }>(
        `/api/bank-rec/statements/import`,
        {
          method: "POST",
          body: JSON.stringify({
            cashAccountCode: cashAccount,
            bankLabel: bankLabel.trim() || undefined,
            source: "auto",
            filename: filename || undefined,
            fileBytes: content,
          }),
        },
      );
      await onImported(r.statementId);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <CardTitle>{useThai ? "นำเข้าใบแจ้งยอดธนาคาร" : "Import bank statement"}</CardTitle>
          <CardDescription>
            {useThai
              ? "รองรับ OFX 2.x และ CSV (KBank/SCB/BBL/KTB/BAY) — ไฟล์ซ้ำจะถูกปฏิเสธอัตโนมัติด้วย hash"
              : "Supports OFX 2.x + CSV (KBank/SCB/BBL/KTB/BAY). Duplicate files rejected by SHA-256 hash."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "บัญชีเงินสด" : "Cash account"}
              </label>
              <Select value={cashAccount} onValueChange={(v) => v && setCashAccount(v)}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.code} value={a.code}>
                      {a.code} {useThai ? a.nameTh ?? a.nameEn ?? "" : a.nameEn ?? a.nameTh ?? ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "ชื่อบัญชีธนาคาร" : "Bank label"}
              </label>
              <Input
                value={bankLabel}
                onChange={(e) => setBankLabel(e.target.value)}
                placeholder="KBank ออมทรัพย์ 123-4-567890"
                className="h-10"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">
              {useThai ? "ไฟล์ (.ofx หรือ .csv)" : "File (.ofx or .csv)"}
            </label>
            <Input type="file" accept=".ofx,.csv,.txt" onChange={handleFile} className="h-10" />
            {filename && (
              <p className="mt-1 text-xs text-muted-foreground">
                {filename} · {content.length} chars
              </p>
            )}
          </div>

          <details>
            <summary className="text-xs text-muted-foreground cursor-pointer">
              {useThai ? "หรือวางเนื้อหาเอง" : "Or paste content directly"}
            </summary>
            <textarea
              className="mt-2 w-full h-32 rounded-md border bg-background p-2 text-xs font-mono"
              placeholder="date,description,credit,debit,reference&#10;2026-05-04,Customer payment,5000.00,0,WIRE-001"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </details>

          {err && <p className="text-sm text-destructive">{err}</p>}
        </CardContent>
        <CardContent className="flex justify-end gap-2 pt-0">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {useThai ? "ยกเลิก" : "Cancel"}
          </Button>
          <Button onClick={submit} disabled={!content.trim() || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {useThai ? "นำเข้า" : "Import"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
