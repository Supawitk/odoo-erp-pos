import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Loader2 } from "lucide-react";
import { api } from "~/lib/api";
import { useAuth } from "~/lib/auth";
import { useCashAccounts } from "~/hooks/use-cash-accounts";
import type { ChartAccount } from "./types";

export function ChartTab({ useThai }: { useThai: boolean }) {
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | ChartAccount["type"]>("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingTh, setPendingTh] = useState("");
  const [pendingEn, setPendingEn] = useState("");
  const [saving, setSaving] = useState(false);
  const isAdmin = useAuth((s) => s.user?.role === "admin");
  const { refresh: refreshCashAccounts } = useCashAccounts();

  const reload = () => {
    setLoading(true);
    return api<ChartAccount[]>(`/api/accounting/chart-of-accounts`)
      .then(setAccounts)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
  }, []);

  const patch = async (
    code: string,
    body: Partial<{ isCashAccount: boolean; isActive: boolean; nameTh: string; nameEn: string }>,
  ) => {
    setSaving(true);
    try {
      const updated = await api<ChartAccount>(`/api/accounting/chart-of-accounts/${code}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setAccounts((cur) => cur.map((a) => (a.code === code ? { ...a, ...updated } : a)));
      // Cash flag flips affect dropdowns elsewhere — refresh the shared cache.
      if (typeof body.isCashAccount === "boolean") {
        await refreshCashAccounts();
      }
    } catch (e: any) {
      alert(`Update failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (a: ChartAccount) => {
    setEditing(a.code);
    setPendingTh(a.nameTh ?? "");
    setPendingEn(a.nameEn ?? "");
  };

  const saveEdit = async (code: string) => {
    await patch(code, {
      nameTh: pendingTh.trim() || undefined,
      nameEn: pendingEn.trim() || undefined,
    });
    setEditing(null);
  };

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

      {isAdmin && (
        <div className="rounded-md border border-blue-200/60 bg-blue-50 dark:bg-blue-950/30 px-3 py-2 text-xs text-muted-foreground">
          {useThai
            ? "โหมดผู้ดูแล — กดที่ป้าย Cash / Active เพื่อเปิด-ปิด, กด Edit เพื่อแก้ชื่อ"
            : "Admin mode — click the Cash / Active pills to toggle, Edit to rename. Type / parent / normal balance are immutable."}
        </div>
      )}

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
                  <th className="px-4 py-2">Cash</th>
                  <th className="px-4 py-2">Active</th>
                  {isAdmin && <th className="px-4 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const isEditing = editing === a.code;
                  return (
                  <tr
                    key={a.code}
                    className={
                      "border-b last:border-0 hover:bg-muted/30 " +
                      (a.parentCode ? "" : "font-medium") +
                      (a.isActive === false ? " opacity-50" : "")
                    }
                  >
                    <td className="px-4 py-1.5 font-mono">{a.code}</td>
                    <td className="px-4 py-1.5">
                      {isEditing ? (
                        <Input
                          value={pendingTh}
                          onChange={(e) => setPendingTh(e.target.value)}
                          className="h-8"
                        />
                      ) : (
                        a.nameTh ?? "—"
                      )}
                    </td>
                    <td className="px-4 py-1.5 text-muted-foreground">
                      {isEditing ? (
                        <Input
                          value={pendingEn}
                          onChange={(e) => setPendingEn(e.target.value)}
                          className="h-8"
                        />
                      ) : (
                        a.nameEn ?? "—"
                      )}
                    </td>
                    <td className="px-4 py-1.5">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono">
                        {a.type}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-xs text-muted-foreground uppercase tracking-wide">
                      {a.normalBalance}
                    </td>
                    <td className="px-4 py-1.5">
                      <button
                        type="button"
                        disabled={!isAdmin || saving}
                        onClick={() => patch(a.code, { isCashAccount: !a.isCashAccount })}
                        className={
                          "rounded-full px-2 py-0.5 text-xs font-medium transition " +
                          (a.isCashAccount
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                            : "bg-muted text-muted-foreground") +
                          (isAdmin ? " hover:opacity-80 cursor-pointer" : " cursor-not-allowed")
                        }
                        title={
                          isAdmin
                            ? "Toggle whether this account appears as a cash account in payment dropdowns + Cash Flow"
                            : "Admin only"
                        }
                      >
                        {a.isCashAccount ? "✓ cash" : "—"}
                      </button>
                    </td>
                    <td className="px-4 py-1.5">
                      <button
                        type="button"
                        disabled={!isAdmin || saving}
                        onClick={() => patch(a.code, { isActive: !a.isActive })}
                        className={
                          "rounded-full px-2 py-0.5 text-xs font-medium transition " +
                          (a.isActive
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                            : "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300") +
                          (isAdmin ? " hover:opacity-80 cursor-pointer" : " cursor-not-allowed")
                        }
                      >
                        {a.isActive ? "active" : "inactive"}
                      </button>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-1.5 text-right whitespace-nowrap">
                        {isEditing ? (
                          <>
                            <Button
                              variant="default"
                              size="sm"
                              className="h-7 px-2 mr-1"
                              disabled={saving}
                              onClick={() => saveEdit(a.code)}
                            >
                              {saving ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                useThai ? "บันทึก" : "Save"
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => setEditing(null)}
                            >
                              {useThai ? "ยกเลิก" : "Cancel"}
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground"
                            onClick={() => startEdit(a)}
                          >
                            {useThai ? "แก้ไข" : "Edit"}
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Tax filings (PP.30 reconciliation + PND.3/53/54) ───────────────────────
