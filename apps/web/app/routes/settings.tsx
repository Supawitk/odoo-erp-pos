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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import {
  Globe,
  Loader2,
  CheckCircle2,
  Building2,
  ShieldCheck,
  Plus,
  Pencil,
  AlertCircle,
  Users,
  X,
} from "lucide-react";
import { useOrgSettings, type CountryMode } from "~/hooks/use-org-settings";
import { useT } from "~/hooks/use-t";
import { api } from "~/lib/api";
import { useAuth, type Role } from "~/lib/auth";
import { PersonCard, type PersonData } from "~/components/person-card";

type SettingsTab = "org" | "branches" | "compliance" | "approvals" | "users";

export default function SettingsPage() {
  const t = useT();
  const [tab, setTab] = useState<SettingsTab>("org");
  const isAdmin = useAuth((s) => s.user?.role === "admin");

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
        {isAdmin && (
          <SettingsTabButton current={tab} value="approvals" onClick={setTab} icon={<ShieldCheck className="h-4 w-4" />}>
            {t.settings_tab_approvals ?? "Approvals"}
          </SettingsTabButton>
        )}
        {isAdmin && (
          <SettingsTabButton current={tab} value="users" onClick={setTab} icon={<Users className="h-4 w-4" />}>
            Users
          </SettingsTabButton>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "org" && <OrganizationTab />}
        {tab === "branches" && <BranchesTab />}
        {tab === "compliance" && <ComplianceTab />}
        {tab === "approvals" && isAdmin && <ApprovalRulesTab />}
        {tab === "users" && isAdmin && <UsersTab />}
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
    defaultBankChargeAccount: "6170",
    paidInCapitalBaht: "",
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
      defaultBankChargeAccount: settings.defaultBankChargeAccount ?? "6170",
      paidInCapitalBaht: settings.paidInCapitalCents
        ? String(Math.round(settings.paidInCapitalCents / 100))
        : "",
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
        defaultBankChargeAccount: form.defaultBankChargeAccount,
        paidInCapitalCents: form.paidInCapitalBaht
          ? Math.round(Number(form.paidInCapitalBaht) * 100)
          : null,
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
      await update(
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
      // Country mode is a master switch — currency, VAT, locale, timezone all
      // shift downstream. Force a hard reload so every cached query, every
      // socket subscription, and every tab observer re-reads the new world
      // from a clean slate. Without this, lingering React state (open modals,
      // in-flight fetches keyed off the old currency, persisted Zustand
      // selectors) can leave the sidebar / KPI labels in the previous language.
      window.location.reload();
    } catch (e: any) {
      setSaveError(e.message);
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

      <ProModeCard />

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

          <div className="grid grid-cols-2 gap-3">
            <Field label={thaiMode ? "บัญชีค่าธรรมเนียมธนาคาร" : "Bank charge GL account"}>
              <Input
                value={form.defaultBankChargeAccount}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    defaultBankChargeAccount: e.target.value.replace(/[^0-9]/g, "").slice(0, 4),
                  }))
                }
                placeholder="6170"
                maxLength={4}
                inputMode="numeric"
              />
              <p className="text-[10px] text-muted-foreground">
                {thaiMode
                  ? "ใช้ตอนคิดค่าธรรมเนียมในการรับ-จ่ายเงิน (ค่าเริ่มต้น 6170)"
                  : "Used when bank fees are deducted from receipts/payments. Default 6170."}
              </p>
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
                ยอดขายเกินจำนวนนี้จะเตือนให้พนักงานขอเลขผู้เสียภาษีของลูกค้า เพื่ออออกใบกำกับภาษีเต็มรูป
              </p>
            </Field>
          )}

          {thaiMode && (
            <Field
              label="ทุนจดทะเบียนชำระแล้ว (฿) — Paid-in Capital"
              description="ใช้คำนวณอัตราภาษีเงินได้นิติบุคคล (SME ≤฿5M) อัตโนมัติ ดูได้จากหนังสือรับรองกรมพัฒนาธุรกิจการค้า"
            >
              <Input
                type="number"
                min={0}
                placeholder="เช่น 1000000 (฿1 ล้าน)"
                value={form.paidInCapitalBaht}
                onChange={(e) =>
                  setForm((f) => ({ ...f, paidInCapitalBaht: e.target.value }))
                }
              />
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

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {description && <p className="text-[10px] text-muted-foreground">{description}</p>}
    </div>
  );
}

// ─── Pro Mode toggles ────────────────────────────────────────────────────────
//
// Each flag below is "off by default" for a reason: the simplest shop should
// never have to think about branches, warehouses, lots, excise, AR-WHT, or
// dual-currency. Flip a switch when the merchant grows into the feature.
function ProModeCard() {
  const { settings, update } = useOrgSettings();
  const thaiMode = settings?.countryMode === "TH";
  const flags = settings?.featureFlags;
  const [saving, setSaving] = useState<string | null>(null);

  if (!flags) return null;

  const toggle = async (key: keyof typeof flags) => {
    setSaving(key);
    try {
      await update({ featureFlags: { [key]: !flags[key] } as any });
      // Reload so every consumer (sidebar, POS, dashboard) repaints with the
      // new flag without us having to thread invalidation through every hook.
      setTimeout(() => window.location.reload(), 250);
    } finally {
      setSaving(null);
    }
  };

  const items: { key: keyof typeof flags; en: string; th: string; desc: string; descTh: string }[] = [
    {
      key: "multiBranch",
      en: "Multiple branches", th: "หลายสาขา",
      desc: "Show branch picker on POS, branch column on dashboard, branch prefix in tax-invoice numbers.",
      descTh: "แสดงตัวเลือกสาขาในหน้า POS, คอลัมน์สาขาในแดชบอร์ด, และคำนำหน้าสาขาในเลขใบกำกับภาษี",
    },
    {
      key: "multiWarehouse",
      en: "Multiple warehouses", th: "หลายคลัง",
      desc: "Show warehouse picker on stock receipt + adjust + transfer screens.",
      descTh: "แสดงตัวเลือกคลังในหน้ารับสินค้า ปรับยอด และโอนย้าย",
    },
    {
      key: "lotSerialTracking",
      en: "Lot / serial tracking", th: "ติดตาม Lot/Serial",
      desc: "Capture lot or serial numbers on goods receipt and surface FEFO consumption.",
      descTh: "บันทึกเลข Lot/Serial เมื่อรับสินค้า และแสดงการตัดสต๊อกแบบ FEFO",
    },
    {
      key: "exciseTax",
      en: "Excise tax (preview)", th: "ภาษีสรรพสามิต (พรีวิว)",
      desc: "Reserved for alcohol / tobacco / sugar-drink merchants. UI surfaces when the product editor ships — no-op today.",
      descTh: "สำหรับร้านสุรา/ยาสูบ/น้ำตาล จะใช้งานได้เมื่อมีหน้าแก้ไขสินค้า — ยังไม่ทำงานในตอนนี้",
    },
    {
      key: "arWht",
      en: "AR Withholding Tax", th: "ภาษีหัก ณ ที่จ่าย (AR)",
      desc: "When juristic-person customers pay you net of WHT, book to GL 1157.",
      descTh: "เมื่อลูกค้านิติบุคคลจ่ายหักภาษี ณ ที่จ่าย บันทึกบัญชี 1157",
    },
    {
      key: "dualCurrencyPrint",
      en: "Foreign-currency invoicing (preview)", th: "ออกใบกำกับสกุลต่างประเทศ (พรีวิว)",
      desc: "Reserved for export merchants. UI surfaces when per-invoice currency override ships — no-op today.",
      descTh: "สำหรับร้านส่งออก จะใช้งานได้เมื่อสามารถเลือกสกุลเงินต่อใบ — ยังไม่ทำงานในตอนนี้",
    },
    {
      key: "restaurantMode",
      en: "Restaurant mode (F&B)", th: "โหมดร้านอาหาร",
      desc: "Order type (dine-in / takeout / delivery), table number, tip handling, and split-bill flow on POS.",
      descTh: "ประเภทออเดอร์ (ทานที่ร้าน / กลับบ้าน / จัดส่ง), หมายเลขโต๊ะ, การรับทิป และการแยกบิล ในหน้า POS",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <Plus className="h-5 w-5 text-primary" />
          <div>
            <CardTitle>{thaiMode ? "โหมดขั้นสูง (Pro Mode)" : "Pro Mode"}</CardTitle>
            <CardDescription>
              {thaiMode
                ? "เปิดเฉพาะฟีเจอร์ที่จำเป็น เพื่อให้หน้าจอเรียบง่าย"
                : "Toggle on only the features you need. Each flag adds UI surfaces and code paths; default OFF keeps the screens lean."}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((it) => {
          const on = flags[it.key];
          const label = thaiMode ? it.th : it.en;
          const desc = thaiMode ? it.descTh : it.desc;
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => toggle(it.key)}
              disabled={!!saving}
              className={
                "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition " +
                (on ? "border-primary bg-primary/5" : "border-border hover:border-primary/40")
              }
            >
              <span
                className={
                  "mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition " +
                  (on ? "justify-end bg-primary" : "justify-start bg-muted")
                }
              >
                <span className="block h-4 w-4 rounded-full bg-background shadow" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{label}</span>
                  {saving === it.key && <Loader2 className="h-3 w-3 animate-spin" />}
                </div>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
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
  const [detail, setDetail] = useState<BranchRow | null>(null);
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
                  <tr
                    key={b.id}
                    className="group border-b last:border-0 cursor-pointer hover:bg-muted/40"
                    onClick={() => setDetail(b)}
                  >
                    <td className="py-2 font-mono">{b.code}</td>
                    <td className="py-2">
                      <span className="font-medium group-hover:text-primary transition-colors">
                        {b.name}
                      </span>
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
                    <td className="py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setEdit(b)}
                        className="text-muted-foreground hover:text-foreground"
                        title="Edit branch"
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

      {detail && (
        <BranchDetailPanel
          branch={detail}
          onEdit={() => { setEdit(detail); setDetail(null); }}
          onClose={() => setDetail(null)}
        />
      )}

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

// ─── Branch detail slide-over with People section ────────────────────────────

function BranchDetailPanel({
  branch,
  onEdit,
  onClose,
}: {
  branch: BranchRow;
  onEdit: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [people, setPeople] = useState<PersonData[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(true);

  useEffect(() => {
    setPeopleLoading(true);
    api<PersonData[]>(`/api/branches/${branch.id}/people`)
      .then(setPeople)
      .catch(() => setPeople([]))
      .finally(() => setPeopleLoading(false));
  }, [branch.id]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Slide-over panel */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Building2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">{branch.name}</h2>
              <p className="font-mono text-xs text-muted-foreground">
                {branch.code}
                {branch.isHeadOffice && (
                  <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary not-italic">
                    {t.settings_branch_head_office}
                  </span>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Branch info */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Branch info
            </h3>
            <div className="rounded-lg border divide-y text-sm">
              <InfoRow label="Status">
                <span
                  className={
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium " +
                    (branch.isActive ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500")
                  }
                >
                  <span className={"h-1.5 w-1.5 rounded-full " + (branch.isActive ? "bg-green-500" : "bg-slate-400")} />
                  {branch.isActive ? t.settings_branch_active : "Inactive"}
                </span>
              </InfoRow>
              {branch.address && (
                <InfoRow label={t.settings_branch_address}>
                  <span className="text-right text-muted-foreground">{branch.address}</span>
                </InfoRow>
              )}
              {branch.phone && (
                <InfoRow label={t.settings_branch_phone}>
                  <span className="text-muted-foreground">{branch.phone}</span>
                </InfoRow>
              )}
            </div>
          </section>

          {/* People section */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                People at this branch
              </h3>
              {!peopleLoading && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {people.length}
                </span>
              )}
            </div>

            {peopleLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : people.length === 0 ? (
              <div className="rounded-lg border border-dashed py-10 text-center">
                <Users className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No people assigned to this branch yet.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Go to the <strong>Users</strong> tab to assign a branch to each user.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {people.map((p) => (
                  <PersonCard key={p.id} person={p} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Footer actions */}
        <div className="border-t px-6 py-4 flex items-center gap-3">
          <Button onClick={onEdit} size="sm" variant="outline" className="flex items-center gap-1.5">
            <Pencil className="h-4 w-4" />
            Edit branch
          </Button>
          <Button onClick={onClose} size="sm" variant="ghost" className="ml-auto">
            Close
          </Button>
        </div>
      </div>
    </>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
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

// ─── Users tab (admin only) ─────────────────────────────────────────────────
const ROLES: Role[] = ["admin", "manager", "accountant", "cashier"];

interface UserRow {
  id: string;
  email: string | null;
  username: string | null;
  name: string;
  role: Role;
  branchCode: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

// ─── Approval Rules tab ──────────────────────────────────────────────────────
//
// Tier-validation rules are normally created via SQL or curl; this tab is the
// admin-friendly way. Each rule says "for this kind of action, when condition
// matches, hold the action until one of these reviewers approves".
interface TierDefinition {
  id: string;
  name: string;
  targetKind: "pos.refund" | "po.confirm" | "accounting.je";
  conditionExpr: string | null;
  sequence: number;
  reviewerIds: string[];
  isActive: boolean;
  createdAt: string;
}

const KINDS: { value: TierDefinition["targetKind"]; en: string; th: string }[] = [
  { value: "pos.refund",    en: "Refund (POS)",         th: "คืนเงิน (POS)" },
  { value: "po.confirm",    en: "Confirm Purchase Order", th: "ยืนยันใบสั่งซื้อ" },
  { value: "accounting.je", en: "Manual Journal Entry",  th: "บันทึกบัญชีเอง" },
];

function ApprovalRulesTab() {
  const t = useT();
  const { settings } = useOrgSettings();
  const thaiMode = settings?.countryMode === "TH";
  const [rules, setRules] = useState<TierDefinition[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<"new" | TierDefinition | null>(null);

  const reload = () => {
    setLoading(true);
    Promise.all([
      api<TierDefinition[]>("/api/approvals/definitions"),
      api<UserRow[]>("/api/users"),
    ])
      .then(([d, u]) => { setRules(d); setUsers(u); })
      .catch((e: any) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { reload(); }, []);

  const disable = async (id: string) => {
    setErr(null);
    try {
      await api(`/api/approvals/definitions/${id}/disable`, { method: "POST" });
      reload();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold">
            {thaiMode ? "กฎการอนุมัติ" : "Approval rules"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {thaiMode
              ? "กำหนดเหตุการณ์ที่ต้องให้ผู้จัดการเซ็นรับรองก่อน เช่น คืนเงิน > ฿1,000 หรือใบสั่งซื้อ > ฿50,000"
              : "Decide which actions need a manager sign-off — e.g. refunds over ฿1,000 or POs over ฿50,000."}
          </p>
        </div>
        <Button onClick={() => setEdit("new")}>
          <Plus className="mr-1 h-4 w-4" />
          {thaiMode ? "เพิ่มกฎ" : "New rule"}
        </Button>
      </div>

      {err && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> {err}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">{thaiMode ? "กำลังโหลด…" : "Loading…"}</p>
      ) : rules.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {thaiMode
              ? "ยังไม่มีกฎ — ทุกการกระทำผ่านได้ทันที"
              : "No rules yet — every action posts immediately."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => {
            const kind = KINDS.find((k) => k.value === r.targetKind);
            const reviewers = r.reviewerIds
              .map((id) => users.find((u) => u.id === id))
              .filter(Boolean) as UserRow[];
            return (
              <Card key={r.id} className={r.isActive ? "" : "opacity-60"}>
                <CardContent className="flex items-start justify-between gap-4 py-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      {!r.isActive && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {thaiMode ? "ปิด" : "disabled"}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                        {thaiMode ? kind?.th : kind?.en}
                      </span>
                      {r.conditionExpr && (
                        <>
                          {" "}
                          {thaiMode ? "เมื่อ" : "when"}{" "}
                          <span className="font-mono">{r.conditionExpr}</span>
                        </>
                      )}
                      {" "}· {thaiMode ? "ลำดับ" : "tier"} {r.sequence}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {thaiMode ? "ผู้อนุมัติ" : "Approvers"}:{" "}
                      {reviewers.length === 0
                        ? thaiMode ? "ผู้ดูแลทุกคน" : "any admin"
                        : reviewers.map((u) => u.name || u.email).join(", ")}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEdit(r)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {r.isActive && (
                      <Button size="sm" variant="ghost" onClick={() => disable(r.id)}>
                        {thaiMode ? "ปิด" : "Disable"}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {edit && (
        <ApprovalRuleModal
          rule={edit === "new" ? null : edit}
          users={users}
          thaiMode={thaiMode}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); reload(); }}
        />
      )}
    </div>
  );
}

function ApprovalRuleModal({
  rule,
  users,
  thaiMode,
  onClose,
  onSaved,
}: {
  rule: TierDefinition | null;
  users: UserRow[];
  thaiMode: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [targetKind, setTargetKind] = useState<TierDefinition["targetKind"]>(
    rule?.targetKind ?? "pos.refund",
  );
  const [conditionExpr, setConditionExpr] = useState(rule?.conditionExpr ?? "amount > 100000");
  const [sequence, setSequence] = useState(rule?.sequence ?? 10);
  const [reviewerIds, setReviewerIds] = useState<string[]>(rule?.reviewerIds ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Only admin / manager / accountant users make sense as reviewers.
  const eligible = users.filter((u) => u.isActive && (u.role === "admin" || u.role === "manager" || u.role === "accountant"));
  const toggleReviewer = (id: string) =>
    setReviewerIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);

  const submit = async () => {
    setErr(null);
    if (!name.trim()) { setErr(thaiMode ? "ตั้งชื่อกฎด้วย" : "name required"); return; }
    setBusy(true);
    try {
      await api("/api/approvals/definitions", {
        method: "POST",
        body: JSON.stringify({
          id: rule?.id,
          name,
          targetKind,
          conditionExpr: conditionExpr.trim() || null,
          sequence: Number(sequence) || 10,
          reviewerIds,
          isActive: true,
        }),
      });
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border bg-background p-5 shadow-lg space-y-3">
        <h3 className="text-lg font-semibold">
          {rule ? (thaiMode ? "แก้ไขกฎ" : "Edit rule") : (thaiMode ? "เพิ่มกฎ" : "New rule")}
        </h3>

        <Field label={thaiMode ? "ชื่อกฎ" : "Rule name"}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={thaiMode ? "เช่น คืนเงิน > ฿1,000" : "e.g. Refund > 1000"}
          />
        </Field>

        <Field label={thaiMode ? "ประเภทการกระทำ" : "Action kind"}>
          <Select value={targetKind} onValueChange={(v) => setTargetKind(v as TierDefinition["targetKind"])}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {thaiMode ? k.th : k.en}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label={thaiMode ? "เงื่อนไข (เว้นว่าง = ทุกกรณี)" : "Condition (empty = always)"}>
          <Input
            value={conditionExpr}
            onChange={(e) => setConditionExpr(e.target.value)}
            placeholder="amount > 100000"
            className="font-mono"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {thaiMode
              ? "ไวยากรณ์: amount, currency, isPartial — เปรียบเทียบด้วย > >= < <= == !="
              : "Syntax: amount, currency, isPartial — compare with > >= < <= == !=. Combine with && / ||."}
          </p>
        </Field>

        <Field label={thaiMode ? "ลำดับชั้น (ต่ำกว่าอนุมัติก่อน)" : "Tier (lower approves first)"}>
          <Input
            type="number"
            min={1}
            value={sequence}
            onChange={(e) => setSequence(Number(e.target.value))}
          />
        </Field>

        <Field label={thaiMode ? "ผู้อนุมัติ (เว้นว่าง = ผู้ดูแลทุกคน)" : "Approvers (empty = any admin)"}>
          <div className="rounded border max-h-40 overflow-y-auto">
            {eligible.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                {thaiMode
                  ? "ยังไม่มีผู้ใช้ที่เป็นผู้ดูแล/ผู้จัดการ/นักบัญชี"
                  : "No admin/manager/accountant users yet."}
              </p>
            ) : eligible.map((u) => (
              <label key={u.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reviewerIds.includes(u.id)}
                  onChange={() => toggleReviewer(u.id)}
                />
                <span className="text-sm">{u.name || u.email}</span>
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">{u.role}</span>
              </label>
            ))}
          </div>
        </Field>

        {err && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {thaiMode ? "ยกเลิก" : "Cancel"}
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : (thaiMode ? "บันทึก" : "Save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function UsersTab() {
  const me = useAuth((s) => s.user);
  const [rows, setRows] = useState<UserRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [profileTarget, setProfileTarget] = useState<UserRow | null>(null);

  const reload = () => {
    setLoading(true);
    Promise.all([
      api<UserRow[]>(`/api/users`),
      api<BranchRow[]>(`/api/branches?activeOnly=false`),
    ])
      .then(([u, b]) => { setRows(u); setBranches(b); })
      .catch((e) => setErr(e.message ?? String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(reload, []);

  const setRole = async (u: UserRow, role: Role) => {
    setBusyId(u.id);
    setErr(null);
    try {
      await api(`/api/users/${u.id}/role`, { method: "PATCH", body: JSON.stringify({ role }) });
      reload();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  };

  const setActive = async (u: UserRow, isActive: boolean) => {
    setBusyId(u.id);
    setErr(null);
    try {
      await api(`/api/users/${u.id}/active`, { method: "PATCH", body: JSON.stringify({ isActive }) });
      reload();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  };

  const setBranch = async (u: UserRow, branchCode: string | null) => {
    setBusyId(u.id);
    setErr(null);
    try {
      await api(`/api/users/${u.id}/branch`, { method: "PATCH", body: JSON.stringify({ branchCode }) });
      reload();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>User accounts</CardTitle>
          <CardDescription>
            Anyone can self-register; new accounts default to <b>cashier</b>. Promote users and
            assign them to a branch so they appear in that branch's People section.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {err && <p className="text-sm text-destructive mb-2">{err}</p>}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 text-left font-medium">Person</th>
                    <th className="py-2 text-left font-medium">Role</th>
                    <th className="py-2 text-left font-medium">Branch</th>
                    <th className="py-2 text-left font-medium">Status</th>
                    <th className="py-2 text-left font-medium">Last login</th>
                    <th className="py-2 w-32"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => {
                    const isMe = u.id === me?.id;
                    const branchLabel = u.branchCode
                      ? (branches.find((b) => b.code === u.branchCode)?.name ?? u.branchCode)
                      : null;
                    return (
                      <tr key={u.id} className="border-b last:border-0">
                        {/* Person cell — clickable PersonCard mini */}
                        <td className="py-2">
                          <button
                            type="button"
                            onClick={() => setProfileTarget(u)}
                            className="flex items-center gap-2 text-left hover:text-primary group"
                          >
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold group-hover:bg-primary/10 transition-colors">
                              {u.name.slice(0, 2).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium leading-tight">
                                {u.name}
                                {isMe && (
                                  <span className="ml-1 text-[10px] text-muted-foreground font-normal">(you)</span>
                                )}
                              </p>
                              <p className="text-[11px] text-muted-foreground">{u.email ?? u.username ?? ""}</p>
                            </div>
                          </button>
                        </td>
                        <td className="py-2">
                          <Select
                            value={u.role}
                            onValueChange={(v) => setRole(u, v as Role)}
                            disabled={busyId === u.id || (isMe && u.role === "admin")}
                          >
                            <SelectTrigger size="sm" className="w-[7.5rem] font-mono uppercase tracking-wide text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLES.map((r) => (
                                <SelectItem key={r} value={r} className="font-mono uppercase tracking-wide text-xs">
                                  {r}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-2">
                          <Select
                            value={u.branchCode ?? "__none__"}
                            onValueChange={(v) => setBranch(u, v === "__none__" ? null : v)}
                            disabled={busyId === u.id || branches.length === 0}
                          >
                            <SelectTrigger size="sm" className="w-[9rem] text-xs">
                              <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">
                                <span className="text-muted-foreground">— None —</span>
                              </SelectItem>
                              {branches.map((b) => (
                                <SelectItem key={b.code} value={b.code}>
                                  <span className="font-mono text-[10px] text-muted-foreground mr-1">{b.code}</span>
                                  {b.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {branchLabel && (
                            <p className="mt-0.5 text-[10px] text-muted-foreground">{branchLabel}</p>
                          )}
                        </td>
                        <td className="py-2">
                          {u.isActive ? (
                            <span className="text-xs text-green-600">active</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">inactive</span>
                          )}
                        </td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "—"}
                        </td>
                        <td className="py-2 text-right space-x-2">
                          <button
                            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                            onClick={() => setResetTarget(u)}
                            disabled={busyId === u.id}
                          >
                            Reset pw
                          </button>
                          {!isMe && (
                            <button
                              className={
                                "text-xs disabled:opacity-50 " +
                                (u.isActive ? "text-destructive hover:underline" : "text-primary hover:underline")
                              }
                              onClick={() => setActive(u, !u.isActive)}
                              disabled={busyId === u.id}
                            >
                              {u.isActive ? "Deactivate" : "Reactivate"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {profileTarget && (
        <PersonCard
          person={{
            ...profileTarget,
            branchCode: profileTarget.branchCode ?? undefined,
          }}
          _forceOpen
          onCloseForced={() => setProfileTarget(null)}
        />
      )}

      {resetTarget && (
        <ResetPasswordModal
          target={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => setResetTarget(null)}
        />
      )}
    </div>
  );
}

function ResetPasswordModal({
  target, onClose, onDone,
}: {
  target: UserRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (password.length < 4) {
      setErr("Password must be at least 4 characters");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/users/${target.id}/password`, {
        method: "PATCH",
        body: JSON.stringify({ password }),
      });
      onDone();
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
        <h2 className="text-lg font-semibold mb-1">Reset password</h2>
        <p className="text-xs text-muted-foreground mb-4">
          {target.name} · {target.email} · all of their existing sessions will be revoked.
        </p>
        <div className="space-y-3">
          <Field label="New password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              minLength={4}
            />
          </Field>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={submit} disabled={busy || password.length < 4}>
              {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Reset password
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
