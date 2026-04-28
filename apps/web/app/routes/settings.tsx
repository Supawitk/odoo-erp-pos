import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Separator } from "~/components/ui/separator";
import {
  Globe,
  Loader2,
  CheckCircle2,
  Building2,
  ShieldCheck,
  Plus,
  Pencil,
  AlertCircle,
} from "lucide-react";
import { useOrgSettings, type CountryMode } from "~/hooks/use-org-settings";
import { useT } from "~/hooks/use-t";
import { api } from "~/lib/api";

type SettingsTab = "org" | "branches" | "compliance";

export default function SettingsPage() {
  const t = useT();
  const [tab, setTab] = useState<SettingsTab>("org");

  return (
    <div className="-m-6 flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex items-center justify-between border-b px-6 pt-6 pb-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t.settings_title}</h1>
        </div>
      </div>
      <div className="flex items-center gap-1 border-b px-6">
        <SettingsTabButton current={tab} value="org" onClick={setTab} icon={<Globe className="h-4 w-4" />}>
          {t.settings_tab_org}
        </SettingsTabButton>
        <SettingsTabButton current={tab} value="branches" onClick={setTab} icon={<Building2 className="h-4 w-4" />}>
          {t.settings_tab_branches}
        </SettingsTabButton>
        <SettingsTabButton current={tab} value="compliance" onClick={setTab} icon={<ShieldCheck className="h-4 w-4" />}>
          {t.settings_tab_compliance}
        </SettingsTabButton>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "org" && <OrganizationTab />}
        {tab === "branches" && <BranchesTab />}
        {tab === "compliance" && <ComplianceTab />}
      </div>
    </div>
  );
}

function SettingsTabButton({
  current, value, onClick, icon, children,
}: {
  current: SettingsTab; value: SettingsTab; onClick: (v: SettingsTab) => void;
  icon?: React.ReactNode; children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(value)}
      className={
        "flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors " +
        (active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {icon}
      {children}
    </button>
  );
}

// ─── Organization tab (existing form, lifted into its own component) ────────
function OrganizationTab() {
  const { settings, loading, error, update } = useOrgSettings();
  const t = useT();

  // Local form buffer. Seeded from server; persisted on Save.
  const [form, setForm] = useState({
    countryMode: "TH" as CountryMode,
    vatRegistered: true,
    currency: "THB",
    locale: "th-TH",
    timezone: "Asia/Bangkok",
    sellerName: "",
    sellerTin: "",
    sellerBranch: "00000",
    sellerAddress: "",
    vatRate: 0.07,
    promptpayBillerId: "",
    abbreviatedTaxInvoiceCapBaht: 1000,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setForm({
      countryMode: settings.countryMode,
      vatRegistered: settings.vatRegistered,
      currency: settings.currency,
      locale: settings.locale,
      timezone: settings.timezone,
      sellerName: settings.sellerName,
      sellerTin: settings.sellerTin ?? "",
      sellerBranch: settings.sellerBranch,
      sellerAddress: settings.sellerAddress,
      vatRate: settings.vatRate,
      promptpayBillerId: settings.promptpayBillerId ?? "",
      abbreviatedTaxInvoiceCapBaht: Math.round(
        settings.abbreviatedTaxInvoiceCapCents / 100,
      ),
    });
  }, [settings]);

  const thaiMode = form.countryMode === "TH";

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await update({
        countryMode: form.countryMode,
        vatRegistered: form.vatRegistered,
        currency: form.currency,
        locale: form.locale,
        timezone: form.timezone,
        sellerName: form.sellerName,
        sellerTin: form.sellerTin || null,
        sellerBranch: form.sellerBranch,
        sellerAddress: form.sellerAddress,
        vatRate: form.vatRate,
        promptpayBillerId: form.promptpayBillerId || null,
        abbreviatedTaxInvoiceCapCents: Math.round(
          form.abbreviatedTaxInvoiceCapBaht * 100,
        ),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const quickSwitch = async (mode: CountryMode) => {
    if (mode === form.countryMode) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await update(
        mode === "TH"
          ? {
              countryMode: "TH",
              currency: "THB",
              locale: "th-TH",
              timezone: "Asia/Bangkok",
              vatRate: 0.07,
              vatRegistered: true,
            }
          : {
              countryMode: "GENERIC",
              currency: "USD",
              locale: "en-US",
              vatRate: 0.1,
              vatRegistered: true,
            },
      );
      setForm((f) => ({
        ...f,
        countryMode: next.countryMode,
        currency: next.currency,
        locale: next.locale,
        timezone: next.timezone,
        vatRate: next.vatRate,
        vatRegistered: next.vatRegistered,
      }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-md pt-12 text-center">
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <p className="text-muted-foreground">
        {thaiMode
          ? "ตั้งค่าทั่วทั้งองค์กร — มีผลทันทีหลังบันทึก"
          : "Organization-wide configuration. Changes apply immediately."}
      </p>

      {/* Country mode — the master switch */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Globe className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>{t.settings_country_mode}</CardTitle>
              <CardDescription>
                {thaiMode ? t.settings_th_desc : t.settings_generic_desc}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => quickSwitch("TH")}
              disabled={saving}
              className={
                "flex flex-col items-start gap-1 rounded-lg border-2 p-4 text-left transition " +
                (thaiMode
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50")
              }
            >
              <div className="flex items-center gap-2">
                <span className="text-2xl">🇹🇭</span>
                <span className="font-semibold">{t.settings_th}</span>
                {thaiMode && <CheckCircle2 className="h-4 w-4 text-primary" />}
              </div>
              <p className="text-xs text-muted-foreground">
                VAT 7% • TIN mod-11 • RE/ABB/TX/CN • PromptPay • PP.30
              </p>
            </button>
            <button
              type="button"
              onClick={() => quickSwitch("GENERIC")}
              disabled={saving}
              className={
                "flex flex-col items-start gap-1 rounded-lg border-2 p-4 text-left transition " +
                (!thaiMode
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50")
              }
            >
              <div className="flex items-center gap-2">
                <span className="text-2xl">🌐</span>
                <span className="font-semibold">{t.settings_generic}</span>
                {!thaiMode && <CheckCircle2 className="h-4 w-4 text-primary" />}
              </div>
              <p className="text-xs text-muted-foreground">
                {thaiMode
                  ? "ใบเสร็จธรรมดา — ตั้งอัตราภาษีได้, ไม่มี PromptPay/PP.30/ฟิลด์ไทย"
                  : "Plain receipts. Configurable tax rate. No Thai-specific fields."}
              </p>
            </button>
          </div>
          {saving && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {thaiMode ? "กำลังบันทึก…" : "Applying…"}
            </p>
          )}
          {saved && !saving && (
            <p className="flex items-center gap-2 text-xs text-green-600">
              <CheckCircle2 className="h-3 w-3" /> {t.settings_save_success}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Business identity */}
      <Card>
        <CardHeader>
          <CardTitle>{thaiMode ? "ข้อมูลธุรกิจ" : "Business identity"}</CardTitle>
          <CardDescription>
            {thaiMode
              ? "พิมพ์ลงบนใบเสร็จและใบกำกับภาษีทุกใบ"
              : "Printed on every receipt / tax invoice."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label={t.settings_seller_name}>
            <Input
              value={form.sellerName}
              onChange={(e) => setForm((f) => ({ ...f, sellerName: e.target.value }))}
              placeholder={thaiMode ? "ร้านตัวอย่าง จำกัด" : "Acme Corp"}
            />
          </Field>
          <Field label={t.settings_seller_address}>
            <Input
              value={form.sellerAddress}
              onChange={(e) => setForm((f) => ({ ...f, sellerAddress: e.target.value }))}
              placeholder={thaiMode ? "เลขที่ ถนน แขวง เขต จังหวัด" : "Street, City, Country"}
            />
          </Field>
          {thaiMode && (
            <div className="grid grid-cols-[2fr_1fr] gap-3">
              <Field label={t.settings_seller_tin}>
                <Input
                  value={form.sellerTin}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, sellerTin: e.target.value.replace(/\D/g, "").slice(0, 13) }))
                  }
                  placeholder="0105551234567"
                />
              </Field>
              <Field label={t.settings_seller_branch}>
                <Input
                  value={form.sellerBranch}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, sellerBranch: e.target.value.replace(/\D/g, "").slice(0, 5) }))
                  }
                  placeholder="00000"
                />
              </Field>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tax */}
      <Card>
        <CardHeader>
          <CardTitle>{thaiMode ? "ภาษี" : "Tax"}</CardTitle>
          <CardDescription>
            {thaiMode
              ? "อัตรา VAT ตรึงที่ 7% ตามพระราชกฤษฎีกา. ถ้ารายได้ต่ำกว่า ฿1.8 ล้าน/ปี ให้ปิด \"จดทะเบียน VAT\" (ออกได้แค่ใบเสร็จ ไม่ออกใบกำกับภาษี)"
              : "Configurable sales-tax rate applied to all taxable lines."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.settings_vat_rate}>
              <Input
                type="number"
                step="0.0001"
                value={form.vatRate}
                onChange={(e) => setForm((f) => ({ ...f, vatRate: Number(e.target.value) }))}
                disabled={thaiMode}
              />
              <p className="text-[10px] text-muted-foreground">
                {(form.vatRate * 100).toFixed(2)}%
              </p>
            </Field>
            <Field label={t.settings_currency}>
              <Input
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase().slice(0, 3) }))}
                disabled={thaiMode}
                maxLength={3}
              />
            </Field>
          </div>

          <label className="flex cursor-pointer items-center gap-3 rounded-md border p-3">
            <input
              type="checkbox"
              checked={form.vatRegistered}
              onChange={(e) => setForm((f) => ({ ...f, vatRegistered: e.target.checked }))}
              className="h-4 w-4"
            />
            <div className="flex-1">
              <p className="text-sm font-medium">
                {thaiMode ? "ผู้ขายจดทะเบียน VAT" : "Charge tax on sales"}
              </p>
              <p className="text-xs text-muted-foreground">
                {thaiMode
                  ? "ถ้าไม่ติ๊ก: ออกได้แค่ใบเสร็จ (RE-) เท่านั้น ใบกำกับภาษี (TX/ABB) ถูกปิด"
                  : "If unchecked, the tax line is zero on every order."}
              </p>
            </div>
          </label>

          {thaiMode && (
            <Field label="เพดานใบกำกับภาษีอย่างย่อ (฿)">
              <Input
                type="number"
                value={form.abbreviatedTaxInvoiceCapBaht}
                onChange={(e) =>
                  setForm((f) => ({ ...f, abbreviatedTaxInvoiceCapBaht: Number(e.target.value) }))
                }
              />
              <p className="text-[10px] text-muted-foreground">
                ยอดขายเกินจำนวนนี้จะเตือนให้พนักงานขอเลขผู้เสียภาษีของลูกค้า เพื่อออกใบกำกับภาษีเต็มรูป
              </p>
            </Field>
          )}
        </CardContent>
      </Card>

      {/* Thai-only sections */}
      {thaiMode && (
        <Card>
          <CardHeader>
            <CardTitle>พร้อมเพย์</CardTitle>
            <CardDescription>
              เลข Biller 15 หลัก (TIN + 00 + sub-account) ใช้สำหรับ QR ชำระเงิน — เว้นว่างถ้าจะปิดปุ่ม QR ที่หน้าชำระเงิน
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              value={form.promptpayBillerId}
              onChange={(e) =>
                setForm((f) => ({ ...f, promptpayBillerId: e.target.value.replace(/\D/g, "").slice(0, 15) }))
              }
              placeholder="099400016551001"
            />
          </CardContent>
        </Card>
      )}

      <Separator />

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {thaiMode ? "โหมด" : "Mode"}: <b>{form.countryMode}</b> · {t.settings_locale}: <b>{form.locale}</b> · {t.settings_currency}: <b>{form.currency}</b>
        </div>
        <div className="flex items-center gap-2">
          {saveError && <span className="text-xs text-destructive">{saveError}</span>}
          {saved && !saving && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <CheckCircle2 className="h-3 w-3" /> {t.settings_save_success}
            </span>
          )}
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t.save}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

// ─── Branches tab ────────────────────────────────────────────────────────────
interface BranchRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  isHeadOffice: boolean;
}

function BranchesTab() {
  const t = useT();
  const [rows, setRows] = useState<BranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<"new" | BranchRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => {
    setLoading(true);
    api<BranchRow[]>(`/api/branches?activeOnly=false`)
      .then(setRows)
      .catch((e) => setErr(e.message ?? String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(reload, []);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>{t.settings_branches_title}</CardTitle>
            <CardDescription>{t.settings_branches_desc}</CardDescription>
          </div>
          <Button onClick={() => setEdit("new")} size="sm">
            <Plus className="h-4 w-4 mr-1" /> {t.settings_new_branch}
          </Button>
        </CardHeader>
        <CardContent>
          {err && <p className="text-sm text-destructive mb-2">{err}</p>}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No branches yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 text-left font-medium">{t.settings_branch_code}</th>
                  <th className="py-2 text-left font-medium">{t.settings_branch_name}</th>
                  <th className="py-2 text-left font-medium">{t.settings_branch_address}</th>
                  <th className="py-2 text-left font-medium">{t.settings_branch_phone}</th>
                  <th className="py-2 text-center font-medium w-20">Status</th>
                  <th className="py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} className="border-b last:border-0">
                    <td className="py-2 font-mono">{b.code}</td>
                    <td className="py-2">
                      <span className="font-medium">{b.name}</span>
                      {b.isHeadOffice && (
                        <span className="ml-2 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                          {t.settings_branch_head_office}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-muted-foreground truncate max-w-[200px]">{b.address ?? "—"}</td>
                    <td className="py-2 text-muted-foreground">{b.phone ?? "—"}</td>
                    <td className="py-2 text-center">
                      {b.isActive ? (
                        <span className="text-xs text-green-600">{t.settings_branch_active}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Inactive</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => setEdit(b)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {edit && (
        <BranchFormModal
          target={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function BranchFormModal({
  target, onClose, onSaved,
}: {
  target: "new" | BranchRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const isNew = target === "new";
  const initial = isNew
    ? { code: "", name: "", address: "", phone: "", isActive: true }
    : {
        code: (target as BranchRow).code,
        name: (target as BranchRow).name,
        address: (target as BranchRow).address ?? "",
        phone: (target as BranchRow).phone ?? "",
        isActive: (target as BranchRow).isActive,
      };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        code: form.code,
        name: form.name,
        address: form.address || undefined,
        phone: form.phone || undefined,
        isActive: form.isActive,
      };
      if (isNew) {
        await api(`/api/branches`, { method: "POST", body: JSON.stringify(body) });
      } else {
        await api(`/api/branches/${(target as BranchRow).id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }
      onSaved();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg shadow-2xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            {isNew ? t.settings_new_branch : `${t.settings_branch_name}: ${(target as BranchRow).name}`}
          </h2>
          <button className="text-muted-foreground hover:text-foreground" onClick={onClose}>×</button>
        </div>
        <div className="space-y-3">
          <Field label={t.settings_branch_code}>
            <Input
              value={form.code}
              onChange={(e) =>
                setForm((f) => ({ ...f, code: e.target.value.replace(/\D/g, "").slice(0, 5) }))
              }
              placeholder="00001"
              disabled={!isNew && (target as BranchRow).isHeadOffice}
            />
            <p className="text-[10px] text-muted-foreground">
              5-digit code. <span className="font-mono">00000</span> = head office.
            </p>
          </Field>
          <Field label={t.settings_branch_name}>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Sukhumvit branch"
            />
          </Field>
          <Field label={t.settings_branch_address}>
            <Input
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            />
          </Field>
          <Field label={t.settings_branch_phone}>
            <Input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </Field>
          {!isNew && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                className="h-4 w-4"
                disabled={(target as BranchRow).isHeadOffice}
              />
              {t.settings_branch_active}
              {(target as BranchRow).isHeadOffice && (
                <span className="text-[10px] text-muted-foreground">(head office cannot be deactivated)</span>
              )}
            </label>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={submit} disabled={busy || !/^\d{5}$/.test(form.code) || !form.name.trim()}>
              {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {isNew ? "Create" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Compliance tab ──────────────────────────────────────────────────────────
interface SequenceAuditRow {
  documentType: string;
  period: string;
  prefix: string;
  allocated: number;
  issued: number;
  missing: number[];
  scope: "tax" | "internal";
}

function ComplianceTab() {
  const t = useT();
  const [rows, setRows] = useState<SequenceAuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => {
    setLoading(true);
    api<SequenceAuditRow[]>(`/api/reports/sequences`)
      .then(setRows)
      .catch((e) => setErr(e.message ?? String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(reload, []);

  // §86 only regulates customer-facing tax docs (RE/ABB/TX/CN). Internal types
  // (PO/GRN) live in different tables and are reported but not audited here.
  const taxRows = rows.filter((r) => r.scope === "tax");
  const totalGaps = taxRows.reduce((s, r) => s + r.missing.length, 0);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t.settings_compliance_title}</CardTitle>
          <CardDescription>{t.settings_compliance_desc}</CardDescription>
        </CardHeader>
        <CardContent>
          {err && <p className="text-sm text-destructive mb-2">{err}</p>}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Auditing…
            </div>
          ) : (
            <>
              <div
                className={
                  "mb-4 flex items-center gap-2 rounded-md p-3 text-sm " +
                  (totalGaps === 0
                    ? "bg-green-500/10 text-green-700"
                    : "bg-destructive/10 text-destructive")
                }
              >
                {totalGaps === 0 ? (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    No gaps detected — all allocated sequence numbers have been issued.
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-4 w-4" />
                    {totalGaps} missing number{totalGaps === 1 ? "" : "s"} detected — investigate immediately.
                  </>
                )}
              </div>
              {rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No sequences allocated yet. Issue your first tax invoice to populate this audit.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-2 text-left font-medium">Type</th>
                      <th className="py-2 text-left font-medium">Period</th>
                      <th className="py-2 text-left font-medium">Prefix</th>
                      <th className="py-2 text-right font-medium">Allocated</th>
                      <th className="py-2 text-right font-medium">Issued</th>
                      <th className="py-2 text-left font-medium">Gaps</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.documentType}_${r.period}`} className="border-b last:border-0">
                        <td className="py-2 font-mono">
                          {r.documentType}
                          {r.scope === "internal" && (
                            <span
                              className="ml-2 inline-block rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground"
                              title="Internal hygiene — not §86 regulated"
                            >
                              internal
                            </span>
                          )}
                        </td>
                        <td className="py-2">{r.period}</td>
                        <td className="py-2 font-mono text-muted-foreground">{r.prefix}</td>
                        <td className="py-2 text-right tabular-nums">{r.allocated}</td>
                        <td className="py-2 text-right tabular-nums">{r.issued}</td>
                        <td className="py-2">
                          {r.scope === "internal" ? (
                            <span className="text-xs text-muted-foreground">n/a</span>
                          ) : r.missing.length === 0 ? (
                            <span className="text-xs text-green-600">none</span>
                          ) : (
                            <span className="text-xs text-destructive font-mono">
                              {r.missing.slice(0, 10).join(", ")}
                              {r.missing.length > 10 && ` … (+${r.missing.length - 10})`}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
          <div className="mt-4 flex justify-end">
            <Button onClick={reload} variant="outline" size="sm" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Re-audit
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
