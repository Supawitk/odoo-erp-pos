import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import {
  BookOpen,
  Calculator,
  CheckCircle2,
  ChevronRight,
  Download,
  FileBarChart,
  Loader2,
  Receipt,
  AlertTriangle,
} from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import { useT } from "~/hooks/use-t";
import { useOrgSettings } from "~/hooks/use-org-settings";

type ChartAccount = {
  code: string;
  name: string;
  nameTh: string | null;
  nameEn: string | null;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  parentCode: string | null;
  isActive: boolean;
  normalBalance: "debit" | "credit";
};

type JournalEntryRow = {
  id: string;
  entryNumber: number;
  date: string;
  description: string;
  reference: string | null;
  sourceModule: string | null;
  sourceId: string | null;
  currency: string;
  totalDebitCents: number;
  totalCreditCents: number;
  status: "draft" | "posted" | "voided";
};

type TrialBalanceRow = {
  accountCode: string;
  accountName: string;
  type: ChartAccount["type"];
  normalBalance: "debit" | "credit";
  debitCents: number;
  creditCents: number;
  balanceCents: number;
};

type Tab = "trial-balance" | "journal" | "chart" | "tax-filings";

export default function AccountingPage() {
  const t = useT();
  const { settings } = useOrgSettings();
  const currency = settings?.currency ?? "THB";
  const useThai = settings?.countryMode === "TH";
  const [tab, setTab] = useState<Tab>("trial-balance");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {useThai ? "บัญชี" : "Accounting"}
          </h1>
          <p className="text-muted-foreground">
            {useThai
              ? "บันทึกรายวัน, ผังบัญชี, งบทดลอง — ตามมาตรฐาน TFRS for NPAEs"
              : "Journal entries, chart of accounts, trial balance — Thai SME (TFRS for NPAEs)"}
          </p>
        </div>
        <div className="inline-flex items-center rounded-md border bg-background p-0.5 shadow-sm">
          <TabBtn value="trial-balance" active={tab} onClick={setTab}>
            <Calculator className="h-4 w-4" />
            {useThai ? "งบทดลอง" : "Trial balance"}
          </TabBtn>
          <TabBtn value="journal" active={tab} onClick={setTab}>
            <BookOpen className="h-4 w-4" />
            {useThai ? "บันทึกรายวัน" : "Journal"}
          </TabBtn>
          <TabBtn value="chart" active={tab} onClick={setTab}>
            <Receipt className="h-4 w-4" />
            {useThai ? "ผังบัญชี" : "Chart of accounts"}
          </TabBtn>
          {useThai && (
            <TabBtn value="tax-filings" active={tab} onClick={setTab}>
              <FileBarChart className="h-4 w-4" />
              {useThai ? "ภาษี" : "Tax filings"}
            </TabBtn>
          )}
        </div>
      </div>

      {tab === "trial-balance" && <TrialBalanceTab currency={currency} useThai={useThai} />}
      {tab === "journal" && <JournalTab currency={currency} useThai={useThai} />}
      {tab === "chart" && <ChartTab useThai={useThai} />}
      {tab === "tax-filings" && <TaxFilingsTab useThai={useThai} currency={currency} />}
    </div>
  );
}

function TabBtn({
  value,
  active,
  onClick,
  children,
}: {
  value: Tab;
  active: Tab;
  onClick: (t: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={
        "inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded transition touch-manipulation " +
        (active === value
          ? "bg-primary text-primary-foreground shadow"
          : "text-muted-foreground hover:bg-muted")
      }
    >
      {children}
    </button>
  );
}

// ─── Trial balance ──────────────────────────────────────────────────────────

function TrialBalanceTab({ currency, useThai }: { currency: string; useThai: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [data, setData] = useState<{
    asOfDate: string;
    rows: TrialBalanceRow[];
    totals: { debitCents: number; creditCents: number; deltaCents: number };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<typeof data>(`/api/accounting/trial-balance?asOf=${asOf}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [asOf]);

  // Group rows by account type for a textbook-style trial balance.
  const groups = useMemo(() => {
    if (!data) return [];
    const order: ChartAccount["type"][] = ["asset", "liability", "equity", "revenue", "expense"];
    const labels: Record<ChartAccount["type"], string> = useThai
      ? {
          asset: "สินทรัพย์",
          liability: "หนี้สิน",
          equity: "ส่วนของเจ้าของ",
          revenue: "รายได้",
          expense: "ค่าใช้จ่าย",
        }
      : {
          asset: "Assets",
          liability: "Liabilities",
          equity: "Equity",
          revenue: "Revenue",
          expense: "Expenses",
        };
    return order
      .map((type) => ({
        type,
        label: labels[type],
        rows: data.rows.filter((r) => r.type === type),
      }))
      .filter((g) => g.rows.length > 0);
  }, [data, useThai]);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {useThai ? "ณ วันที่" : "As of"}
          </label>
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="w-44 h-10"
          />
        </div>
        {data && (
          <div className="ml-auto text-right">
            <div className="text-xs text-muted-foreground">
              {useThai ? "ผลต่าง (ต้องเป็นศูนย์)" : "Δ (must be zero)"}
            </div>
            <div
              className={
                "text-lg font-semibold tabular-nums " +
                (data.totals.deltaCents === 0 ? "text-emerald-600" : "text-rose-600")
              }
            >
              {formatMoney(data.totals.deltaCents, currency)}
            </div>
          </div>
        )}
      </div>

      {err && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {useThai ? "ยังไม่มีรายการบัญชีในช่วงนี้" : "No posted entries yet."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">{useThai ? "รหัส" : "Code"}</th>
                  <th className="px-4 py-2">{useThai ? "บัญชี" : "Account"}</th>
                  <th className="px-4 py-2 text-right">Dr</th>
                  <th className="px-4 py-2 text-right">Cr</th>
                  <th className="px-4 py-2 text-right">
                    {useThai ? "ยอดคงเหลือ" : "Balance"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.type} group={g} currency={currency} />
                ))}
                <tr className="border-t-2 bg-muted/30 font-semibold">
                  <td className="px-4 py-2" colSpan={2}>
                    {useThai ? "รวม" : "Totals"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMoney(data.totals.debitCents, currency)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMoney(data.totals.creditCents, currency)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span
                      className={
                        data.totals.deltaCents === 0 ? "text-emerald-600" : "text-rose-600"
                      }
                    >
                      Δ {formatMoney(data.totals.deltaCents, currency)}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function GroupRows({
  group,
  currency,
}: {
  group: { type: string; label: string; rows: TrialBalanceRow[] };
  currency: string;
}) {
  return (
    <>
      <tr className="bg-muted/20">
        <td className="px-4 py-1.5 text-xs uppercase tracking-wide text-muted-foreground" colSpan={5}>
          {group.label}
        </td>
      </tr>
      {group.rows.map((r) => (
        <tr key={r.accountCode} className="border-b last:border-0">
          <td className="px-4 py-2 font-mono text-xs">{r.accountCode}</td>
          <td className="px-4 py-2">{r.accountName}</td>
          <td className="px-4 py-2 text-right tabular-nums">
            {r.debitCents ? formatMoney(r.debitCents, currency) : "—"}
          </td>
          <td className="px-4 py-2 text-right tabular-nums">
            {r.creditCents ? formatMoney(r.creditCents, currency) : "—"}
          </td>
          <td className="px-4 py-2 text-right tabular-nums font-medium">
            {formatMoney(r.balanceCents, currency)}
          </td>
        </tr>
      ))}
    </>
  );
}

// ─── Journal entries ────────────────────────────────────────────────────────

function JournalTab({ currency, useThai }: { currency: string; useThai: boolean }) {
  const [entries, setEntries] = useState<JournalEntryRow[]>([]);
  const [filter, setFilter] = useState<"all" | "pos" | "manual" | "void">("all");
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
                  <tr key={e.id} className="border-b last:border-0 hover:bg-muted/40">
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

// ─── Chart of accounts ──────────────────────────────────────────────────────

function ChartTab({ useThai }: { useThai: boolean }) {
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | ChartAccount["type"]>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<ChartAccount[]>(`/api/accounting/chart-of-accounts`)
      .then(setAccounts)
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return accounts
      .filter((a) => filter === "all" || a.type === filter)
      .filter(
        (a) =>
          q === "" ||
          a.code.includes(q) ||
          (a.nameTh ?? "").toLowerCase().includes(q) ||
          (a.nameEn ?? "").toLowerCase().includes(q),
      );
  }, [accounts, filter, search]);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {useThai ? "ประเภท" : "Type"}
          </label>
          <Select value={filter} onValueChange={(v) => setFilter((v as typeof filter) ?? "all")}>
            <SelectTrigger size="sm" className="w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{useThai ? "ทั้งหมด" : "All"}</SelectItem>
              <SelectItem value="asset">{useThai ? "สินทรัพย์" : "Asset"}</SelectItem>
              <SelectItem value="liability">{useThai ? "หนี้สิน" : "Liability"}</SelectItem>
              <SelectItem value="equity">{useThai ? "ส่วนของเจ้าของ" : "Equity"}</SelectItem>
              <SelectItem value="revenue">{useThai ? "รายได้" : "Revenue"}</SelectItem>
              <SelectItem value="expense">{useThai ? "ค่าใช้จ่าย" : "Expense"}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 flex-1 max-w-sm">
          <label className="text-xs text-muted-foreground">
            {useThai ? "ค้นหา" : "Search"}
          </label>
          <Input
            placeholder={useThai ? "รหัส หรือ ชื่อบัญชี" : "Code or account name"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10"
          />
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} / {accounts.length}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">{useThai ? "รหัส" : "Code"}</th>
                  <th className="px-4 py-2">{useThai ? "ชื่อ (ไทย)" : "Name (Thai)"}</th>
                  <th className="px-4 py-2">{useThai ? "ชื่อ (อังกฤษ)" : "Name (English)"}</th>
                  <th className="px-4 py-2">{useThai ? "ประเภท" : "Type"}</th>
                  <th className="px-4 py-2">{useThai ? "ยอดปกติ" : "Normal"}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr
                    key={a.code}
                    className={
                      "border-b last:border-0 hover:bg-muted/30 " +
                      (a.parentCode ? "" : "font-medium")
                    }
                  >
                    <td className="px-4 py-1.5 font-mono">{a.code}</td>
                    <td className="px-4 py-1.5">{a.nameTh ?? "—"}</td>
                    <td className="px-4 py-1.5 text-muted-foreground">{a.nameEn ?? "—"}</td>
                    <td className="px-4 py-1.5">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono">
                        {a.type}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-xs text-muted-foreground uppercase tracking-wide">
                      {a.normalBalance}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Tax filings (PP.30 reconciliation + PND.3/53/54) ───────────────────────

type Pp30Recon = {
  period: string;
  pp30: {
    outputVatGrossCents: number;
    refundedVatCents: number;
    outputVatNetCents: number;
    inputVatClaimedCents: number;
    netVatPayableCents: number;
  };
  gl: {
    outputVatCreditCents: number;
    outputVatDebitCents: number;
    outputVatNetCents: number;
    inputVatDebitCents: number;
    inputVatCreditCents: number;
    inputVatNetCents: number;
    deferredOutputCents: number;
    deferredInputCents: number;
  };
  delta: { outputVatCents: number; inputVatCents: number };
  reconciled: boolean;
  source: { journalEntryCount: number; vendorBillCount: number };
};

type PndForm = "PND3" | "PND53" | "PND54";

type PndRow = {
  seq: number;
  supplierId: string;
  supplierName: string;
  supplierLegalName: string;
  supplierTin: string | null;
  supplierBranchCode: string;
  whtCategory: string;
  whtCategoryLabel: string;
  rdSection: string;
  rateBp: number;
  paidNetCents: number;
  whtCents: number;
  billCount: number;
};

type PndReport = {
  form: PndForm;
  period: string;
  rows: PndRow[];
  totals: {
    paidNetCents: number;
    whtCents: number;
    billCount: number;
    supplierCount: number;
  };
};

function TaxFilingsTab({ useThai, currency }: { useThai: boolean; currency: string }) {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [recon, setRecon] = useState<Pp30Recon | null>(null);
  const [pnd3, setPnd3] = useState<PndReport | null>(null);
  const [pnd53, setPnd53] = useState<PndReport | null>(null);
  const [pnd54, setPnd54] = useState<PndReport | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    setBusy(true);
    const q = `?year=${year}&month=${month}`;
    Promise.all([
      api<Pp30Recon>(`/api/reports/pp30/reconcile${q}`).catch(() => null),
      api<PndReport>(`/api/reports/pnd/PND3${q}`).catch(() => null),
      api<PndReport>(`/api/reports/pnd/PND53${q}`).catch(() => null),
      api<PndReport>(`/api/reports/pnd/PND54${q}`).catch(() => null),
    ])
      .then(([r, p3, p53, p54]) => {
        setRecon(r);
        setPnd3(p3);
        setPnd53(p53);
        setPnd54(p54);
      })
      .finally(() => setBusy(false));
  };

  useEffect(reload, [year, month]);

  const periodLabel = `${year}-${String(month).padStart(2, "0")}`;

  return (
    <div className="space-y-5">
      {/* Period picker */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {useThai ? "ปี" : "Year"}
          </label>
          <Input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="h-10 w-24 tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {useThai ? "เดือน" : "Month"}
          </label>
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v ?? "1"))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {String(m).padStart(2, "0")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={reload} disabled={busy} className="h-10">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
          {useThai ? "รีเฟรช" : "Refresh"}
        </Button>
      </div>

      {/* PP.30 ↔ GL reconciliation */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                {recon?.reconciled ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                )}
                {useThai ? "การกระทบยอด ภ.พ.30 กับบัญชี" : "PP.30 ↔ GL reconciliation"}
              </CardTitle>
              <CardDescription>
                {useThai
                  ? `เดือน ${periodLabel} — ความคลาดเคลื่อนที่ยอมรับได้คือ ฿1`
                  : `Period ${periodLabel} — tolerance ฿1`}
              </CardDescription>
            </div>
            <a href={`/api/reports/pp30.csv?year=${year}&month=${month}`}>
              <Button variant="outline" size="sm" className="h-9">
                <Download className="h-3 w-3" /> PP.30 CSV
              </Button>
            </a>
          </div>
        </CardHeader>
        <CardContent>
          {!recon ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
              <ReconCard
                title={useThai ? "ภาษีขาย (Output VAT)" : "Output VAT"}
                pp30Cents={recon.pp30.outputVatNetCents}
                glCents={recon.gl.outputVatNetCents}
                deltaCents={recon.delta.outputVatCents}
                currency={currency}
                useThai={useThai}
              />
              <ReconCard
                title={useThai ? "ภาษีซื้อ (Input VAT)" : "Input VAT"}
                pp30Cents={recon.pp30.inputVatClaimedCents}
                glCents={recon.gl.inputVatNetCents}
                deltaCents={recon.delta.inputVatCents}
                currency={currency}
                useThai={useThai}
              />
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground lg:col-span-2">
                {useThai ? "VAT ต้องชำระสุทธิ" : "Net VAT payable"}: {" "}
                <span className="font-semibold tabular-nums">
                  {formatMoney(recon.pp30.netVatPayableCents, currency)}
                </span>
                <span className="ml-3">
                  {useThai
                    ? `ที่มา — ${recon.source.journalEntryCount} รายการ GL, ${recon.source.vendorBillCount} ใบแจ้งหนี้`
                    : `Source — ${recon.source.journalEntryCount} GL entries, ${recon.source.vendorBillCount} vendor bills`}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* PND.3 / PND.53 / PND.54 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <PndCard
          form="PND3"
          report={pnd3}
          year={year}
          month={month}
          currency={currency}
          useThai={useThai}
        />
        <PndCard
          form="PND53"
          report={pnd53}
          year={year}
          month={month}
          currency={currency}
          useThai={useThai}
        />
        <PndCard
          form="PND54"
          report={pnd54}
          year={year}
          month={month}
          currency={currency}
          useThai={useThai}
        />
      </div>
    </div>
  );
}

function ReconCard({
  title,
  pp30Cents,
  glCents,
  deltaCents,
  currency,
  useThai,
}: {
  title: string;
  pp30Cents: number;
  glCents: number;
  deltaCents: number;
  currency: string;
  useThai: boolean;
}) {
  const ok = Math.abs(deltaCents) <= 100;
  return (
    <div className="rounded-md border p-3 space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="grid grid-cols-3 text-sm tabular-nums">
        <div>
          <p className="text-[11px] text-muted-foreground">PP.30</p>
          <p className="font-semibold">{formatMoney(pp30Cents, currency)}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">GL</p>
          <p className="font-semibold">{formatMoney(glCents, currency)}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">
            {useThai ? "ส่วนต่าง" : "Delta"}
          </p>
          <p
            className={
              "font-semibold " +
              (ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")
            }
          >
            {formatMoney(deltaCents, currency)}
          </p>
        </div>
      </div>
    </div>
  );
}

function PndCard({
  form,
  report,
  year,
  month,
  currency,
  useThai,
}: {
  form: PndForm;
  report: PndReport | null;
  year: number;
  month: number;
  currency: string;
  useThai: boolean;
}) {
  const titleByForm: Record<PndForm, string> = {
    PND3: useThai ? "ภ.ง.ด.3 — บุคคลธรรมดา" : "PND.3 — natural persons",
    PND53: useThai ? "ภ.ง.ด.53 — นิติบุคคล" : "PND.53 — juristic persons",
    PND54: useThai ? "ภ.ง.ด.54 — ต่างประเทศ" : "PND.54 — foreign payments",
  };
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{titleByForm[form]}</CardTitle>
            <CardDescription>
              {useThai
                ? `ผู้ขาย ${report?.totals.supplierCount ?? 0} ราย · ${
                    report?.totals.billCount ?? 0
                  } ใบ`
                : `${report?.totals.supplierCount ?? 0} suppliers · ${
                    report?.totals.billCount ?? 0
                  } bills`}
            </CardDescription>
          </div>
          <a
            href={`/api/reports/pnd/${form}/csv?year=${year}&month=${month}`}
          >
            <Button variant="outline" size="sm" className="h-8">
              <Download className="h-3 w-3" /> CSV
            </Button>
          </a>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="rounded-md bg-muted/30 px-3 py-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {useThai ? "ภาษีหัก ณ ที่จ่าย" : "Total WHT withheld"}
            </span>
            <span className="font-semibold tabular-nums">
              {formatMoney(report?.totals.whtCents ?? 0, currency)}
            </span>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{useThai ? "ฐานเงินที่จ่าย" : "Paid net"}</span>
            <span className="tabular-nums">
              {formatMoney(report?.totals.paidNetCents ?? 0, currency)}
            </span>
          </div>
        </div>
        {report && report.rows.length > 0 ? (
          <div className="max-h-64 overflow-y-auto -mx-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1">{useThai ? "ผู้ขาย" : "Supplier"}</th>
                  <th className="px-2 py-1">{useThai ? "ประเภท" : "Type"}</th>
                  <th className="px-2 py-1 text-right">{useThai ? "ฐาน" : "Net"}</th>
                  <th className="px-2 py-1 text-right">WHT</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.slice(0, 50).map((r) => (
                  <tr
                    key={`${r.supplierId}-${r.whtCategory}`}
                    className="border-t border-border/50"
                  >
                    <td className="px-2 py-1">{r.supplierName}</td>
                    <td className="px-2 py-1 text-muted-foreground">
                      {r.whtCategoryLabel} · {r.rdSection}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {formatMoney(r.paidNetCents, currency)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums font-medium">
                      {formatMoney(r.whtCents, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic px-2">
            {useThai ? "ไม่มีรายการในเดือนนี้" : "No bills paid this month."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
