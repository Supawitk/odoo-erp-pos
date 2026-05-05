import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { ChevronRight, Loader2 } from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import type { JournalEntryRow } from "./types";

export function JournalTab({
  currency,
  useThai,
  focusJeId,
}: {
  currency: string;
  useThai: boolean;
  focusJeId?: string | null;
}) {
  const [entries, setEntries] = useState<JournalEntryRow[]>([]);
  const [filter, setFilter] = useState<"all" | "pos" | "manual" | "void">(
    focusJeId ? "manual" : "all", // arriving from /approvals → most likely a manual JE
  );
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<JournalEntryRow | null>(null);

  const reload = () => {
    setLoading(true);
    const q = filter === "all" ? "" : `?source=${filter === "void" ? "void" : filter}`;
    api<JournalEntryRow[]>(`/api/accounting/journal-entries${q}`)
      .then(setEntries)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Scroll + open the focused entry once data lands.
  useEffect(() => {
    if (!focusJeId || loading || entries.length === 0) return;
    const match = entries.find((e) => e.id === focusJeId);
    if (match) setSelected(match);
    setTimeout(() => {
      const el = document.querySelector(`[data-je-id="${focusJeId}"]`);
      if (el) (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
  }, [focusJeId, loading, entries]);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {useThai ? "แหล่งที่มา" : "Source"}
          </label>
          <Select value={filter} onValueChange={(v) => setFilter((v as typeof filter) ?? "all")}>
            <SelectTrigger size="sm" className="w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{useThai ? "ทั้งหมด" : "All"}</SelectItem>
              <SelectItem value="pos">POS</SelectItem>
              <SelectItem value="manual">{useThai ? "บันทึกเอง" : "Manual"}</SelectItem>
              <SelectItem value="void">{useThai ? "ยกเลิก" : "Voided"}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {useThai ? `${entries.length} รายการ` : `${entries.length} entries`}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {useThai ? "ยังไม่มีรายการ" : "No entries match this filter."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">#</th>
                  <th className="px-4 py-2">{useThai ? "วันที่" : "Date"}</th>
                  <th className="px-4 py-2">{useThai ? "คำอธิบาย" : "Description"}</th>
                  <th className="px-4 py-2">{useThai ? "อ้างอิง" : "Reference"}</th>
                  <th className="px-4 py-2 text-right">Dr / Cr</th>
                  <th className="px-4 py-2 text-right">{useThai ? "สถานะ" : "Status"}</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    data-je-id={e.id}
                    className={`border-b last:border-0 hover:bg-muted/40 ${
                      e.id === focusJeId ? "bg-primary/5 ring-2 ring-primary ring-inset" : ""
                    }`}
                  >
                    <td className="px-4 py-2 font-mono text-xs">#{e.entryNumber}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{e.date}</td>
                    <td className="px-4 py-2">{e.description}</td>
                    <td className="px-4 py-2 font-mono text-xs">{e.reference ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatMoney(e.totalDebitCents, e.currency)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <StatusPill status={e.status} useThai={useThai} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setSelected(e)}>
                        {useThai ? "ดู" : "View"}
                        <ChevronRight className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {selected && (
        <JournalEntryModal
          entryId={selected.id}
          currency={currency}
          onClose={() => setSelected(null)}
          onVoided={reload}
          useThai={useThai}
        />
      )}
    </div>
  );
}

function StatusPill({
  status,
  useThai,
}: {
  status: JournalEntryRow["status"];
  useThai: boolean;
}) {
  const map = {
    posted: { cls: "bg-emerald-500/15 text-emerald-700", label: useThai ? "บันทึกแล้ว" : "Posted" },
    draft: { cls: "bg-amber-500/15 text-amber-700", label: useThai ? "ร่าง" : "Draft" },
    voided: { cls: "bg-rose-500/15 text-rose-700", label: useThai ? "ยกเลิก" : "Voided" },
  };
  const m = map[status] ?? map.draft;
  return (
    <span className={"inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium " + m.cls}>
      {m.label}
    </span>
  );
}

function JournalEntryModal({
  entryId,
  currency,
  onClose,
  onVoided,
  useThai,
}: {
  entryId: string;
  currency: string;
  onClose: () => void;
  onVoided: () => void;
  useThai: boolean;
}) {
  const [entry, setEntry] = useState<any>(null);
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<any>(`/api/accounting/journal-entries/${entryId}`)
      .then(setEntry)
      .catch((e) => setErr(e.message));
  }, [entryId]);

  const doVoid = async () => {
    if (voidReason.trim().length < 3) {
      setErr(useThai ? "เหตุผลอย่างน้อย 3 ตัวอักษร" : "Reason must be ≥3 chars");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/accounting/journal-entries/${entryId}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: voidReason }),
      });
      onVoided();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle>
            {useThai ? "รายการบัญชี" : "Journal entry"} #{entry?.entryNumber ?? "…"}
          </CardTitle>
          <CardDescription>
            {entry ? `${entry.date} · ${entry.description}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!entry ? (
            <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2">{useThai ? "บัญชี" : "Account"}</th>
                    <th className="py-2 text-right">Dr</th>
                    <th className="py-2 text-right">Cr</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((l: any) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="py-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {l.accountCode}
                        </span>{" "}
                        {l.accountName}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {l.debitCents ? formatMoney(l.debitCents, currency) : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {l.creditCents ? formatMoney(l.creditCents, currency) : "—"}
                      </td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="pt-3">
                      {useThai ? "รวม" : "Totals"}
                    </td>
                    <td className="pt-3 text-right tabular-nums">
                      {formatMoney(entry.totalDebitCents, entry.currency)}
                    </td>
                    <td className="pt-3 text-right tabular-nums">
                      {formatMoney(entry.totalCreditCents, entry.currency)}
                    </td>
                  </tr>
                </tbody>
              </table>

              {entry.status === "posted" && (
                <div className="mt-4 space-y-2">
                  <label className="text-xs text-muted-foreground">
                    {useThai
                      ? "เหตุผลในการยกเลิก (อย่างน้อย 3 ตัวอักษร)"
                      : "Void reason (≥3 chars)"}
                  </label>
                  <Input
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    className="h-10"
                    placeholder={useThai ? "เช่น แก้ไขผิดพลาด" : "e.g. Posting error"}
                  />
                </div>
              )}
              {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
              <div className="mt-4 flex gap-2 justify-end">
                <Button variant="outline" onClick={onClose} className="h-10">
                  {useThai ? "ปิด" : "Close"}
                </Button>
                {entry.status === "posted" && (
                  <Button
                    variant="destructive"
                    onClick={doVoid}
                    disabled={busy}
                    className="h-10"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : useThai ? "ยกเลิกรายการ" : "Void entry"}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

