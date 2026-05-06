import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  BookOpen,
  CalendarCheck,
  Calculator,
  ChevronDown,
  FileBarChart,
  Info,
  Receipt,
  FileSpreadsheet,
} from "lucide-react";
import { useT } from "~/hooks/use-t";
import { useOrgSettings } from "~/hooks/use-org-settings";
import type { Tab } from "./types";
import { TrialBalanceTab } from "./trial-balance";
import { BalanceSheetTab } from "./balance-sheet";
import { ProfitLossTab } from "./profit-loss";
import { CashFlowTab } from "./cash-flow";
import { BankRecTab } from "./bank-rec";
import { FixedAssetsTab } from "./fixed-assets";
import { JournalTab } from "./journal";
import { ChartTab } from "./chart";
import { TaxFilingsTab } from "./tax-filings";
import { TfrsTab } from "./tfrs";
import { PeriodCloseTab } from "./period-close";
import { CashBookTab } from "./cash-book";

export default function AccountingPage() {
  const t = useT();
  const { settings } = useOrgSettings();
  const currency = settings?.currency ?? "THB";
  const useThai = settings?.countryMode === "TH";
  const vatRegistered = settings?.vatRegistered ?? false;
  // The tab itself shows for any TH merchant — PND.3/53/54 (withholding-tax
  // remittance) is the *payer's* obligation regardless of VAT status. The
  // PP.30 + Input VAT sections inside the tab gate further on vatRegistered.
  const taxFilingsTabVisible = useThai;
  const [searchParams] = useSearchParams();
  // ?focusJe=<id> from /approvals — bounce to the journal tab and let
  // JournalTab pick up the id to highlight.
  const focusJeId = searchParams.get("focusJe");
  const [tab, setTab] = useState<Tab>(focusJeId ? "journal" : "trial-balance");

  // If the operator flips out of TH mode while viewing tax-filings, bounce
  // them to a tab that still exists.
  useEffect(() => {
    if (tab === "tax-filings" && !taxFilingsTabVisible) {
      setTab("trial-balance");
    }
  }, [tab, taxFilingsTabVisible]);

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
              : "Journal entries, chart of accounts, trial balance"}
          </p>
        </div>
        {/* Single-row tab bar. Five read-only statements are grouped under a
            Statements dropdown (trial balance, balance sheet, P&L, cash flow,
            TFRS) so the bar fits on one row. Day-to-day entry + reconciliation
            tabs stay flat for one-click access. Tax filings stays flat because
            it's branched by VAT status and lives outside the statements
            grouping conceptually. */}
        <div className="inline-flex flex-nowrap items-center rounded-md border bg-background p-0.5 shadow-sm overflow-x-auto max-w-full">
          <StatementsDropdown active={tab} onSelect={setTab} useThai={useThai} />
          {taxFilingsTabVisible && (
            <TabBtn value="tax-filings" active={tab} onClick={setTab}>
              <FileBarChart className="h-4 w-4" />
              {useThai ? "ภาษี" : "Tax filings"}
            </TabBtn>
          )}
          <TabBtn value="journal" active={tab} onClick={setTab}>
            <BookOpen className="h-4 w-4" />
            {useThai ? "บันทึกรายวัน" : "Journal"}
          </TabBtn>
          <TabBtn value="chart" active={tab} onClick={setTab}>
            <Receipt className="h-4 w-4" />
            {useThai ? "ผังบัญชี" : "Chart of accounts"}
          </TabBtn>
          <TabBtn value="bank-rec" active={tab} onClick={setTab}>
            <Calculator className="h-4 w-4" />
            {useThai ? "กระทบยอดธนาคาร" : "Bank rec"}
          </TabBtn>
          <TabBtn value="fixed-assets" active={tab} onClick={setTab}>
            <Calculator className="h-4 w-4" />
            {useThai ? "สินทรัพย์ถาวร" : "Fixed assets"}
          </TabBtn>
          <TabBtn value="cash-book" active={tab} onClick={setTab}>
            <BookOpen className="h-4 w-4" />
            {useThai ? "สมุดเงินสด" : "Cash book"}
          </TabBtn>
          <TabBtn value="period-close" active={tab} onClick={setTab}>
            <CalendarCheck className="h-4 w-4" />
            {useThai ? "ปิดงวด" : "Period close"}
          </TabBtn>
        </div>
      </div>

      {tab === "trial-balance" && <TrialBalanceTab currency={currency} useThai={useThai} />}
      {tab === "balance-sheet" && <BalanceSheetTab currency={currency} useThai={useThai} />}
      {tab === "profit-loss" && <ProfitLossTab currency={currency} useThai={useThai} />}
      {tab === "cash-flow" && <CashFlowTab currency={currency} useThai={useThai} />}
      {tab === "bank-rec" && <BankRecTab currency={currency} useThai={useThai} />}
      {tab === "fixed-assets" && (
        <FixedAssetsTab currency={currency} useThai={useThai} />
      )}
      {tab === "journal" && <JournalTab currency={currency} useThai={useThai} focusJeId={focusJeId} />}
      {tab === "chart" && <ChartTab useThai={useThai} />}
      {tab === "tfrs" && <TfrsTab currency={currency} useThai={useThai} />}
      {tab === "cash-book" && <CashBookTab currency={currency} useThai={useThai} />}
      {tab === "period-close" && <PeriodCloseTab currency={currency} useThai={useThai} />}
      {tab === "tax-filings" &&
        (taxFilingsTabVisible ? (
          <TaxFilingsTab
            useThai={useThai}
            currency={currency}
            vatRegistered={vatRegistered}
          />
        ) : (
          <TaxFilingsUnavailable
            countryMode={settings?.countryMode ?? "TH"}
            vatRegistered={vatRegistered}
          />
        ))}
    </div>
  );
}

/**
 * Friendly placeholder shown when somebody lands on the Tax Filings tab in a
 * configuration where it doesn't apply — non-TH country mode, or a TH merchant
 * below the ฿1.8M VAT registration threshold. Reached via deep link, browser
 * back button, or a settings change while the tab was open.
 */
function TaxFilingsUnavailable({
  countryMode,
  vatRegistered,
}: {
  countryMode: "TH" | "GENERIC";
  vatRegistered: boolean;
}) {
  const reason: "not-th" | "not-vat" =
    countryMode !== "TH" ? "not-th" : "not-vat";
  const useThai = countryMode === "TH";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Info className="h-5 w-5 text-muted-foreground" />
          {useThai ? "ไม่ได้เปิดใช้งานในการตั้งค่าปัจจุบัน" : "Not enabled for the current setup"}
        </CardTitle>
        <CardDescription>
          {reason === "not-th"
            ? useThai
              ? "PP.30 และ PND มีไว้สำหรับโหมด Thailand เท่านั้น"
              : "PP.30 and PND filings are specific to Thailand mode."
            : useThai
              ? "ผู้ประกอบการที่ไม่ได้จดทะเบียน VAT ไม่ต้องยื่น ภ.พ.30 หรือ ภ.ง.ด."
              : "A non–VAT-registered merchant does not file PP.30 or PND forms."}
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground space-y-3">
        <p>
          {reason === "not-th"
            ? useThai
              ? "ถ้าธุรกิจของคุณอยู่ในประเทศไทย เปลี่ยนโหมดเป็น Thailand ที่หน้า Settings เพื่อเปิดแบบฟอร์มภาษีไทย"
              : "If you operate in Thailand, switch the country mode to Thailand on the Settings page to enable Thai tax filings."
            : useThai
              ? "เปิด VAT registered = true ในหน้า Settings เมื่อรายได้รวมเกิน ฿1.8 ล้าน/ปี และคุณได้จดทะเบียนกับกรมสรรพากรแล้ว"
              : "Toggle “VAT registered” on in Settings once your annual revenue exceeds ฿1.8M and you’ve registered with the Revenue Department."}
        </p>
        <p>
          <a
            href="/settings"
            className="text-primary underline-offset-2 hover:underline"
          >
            {useThai ? "ไปที่หน้า Settings →" : "Go to Settings →"}
          </a>
        </p>
      </CardContent>
    </Card>
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

type StatementTab = "trial-balance" | "balance-sheet" | "profit-loss" | "cash-flow" | "tfrs";

const STATEMENT_TABS: readonly StatementTab[] = [
  "trial-balance",
  "balance-sheet",
  "profit-loss",
  "cash-flow",
  "tfrs",
] as const;

function statementLabel(t: StatementTab, useThai: boolean): string {
  switch (t) {
    case "trial-balance": return useThai ? "งบทดลอง" : "Trial balance";
    case "balance-sheet": return useThai ? "งบดุล" : "Balance sheet";
    case "profit-loss":   return useThai ? "กำไรขาดทุน" : "P&L";
    case "cash-flow":     return useThai ? "งบกระแสเงินสด" : "Cash flow";
    case "tfrs":          return useThai ? "งบ TFRS" : "TFRS reports";
  }
}

function StatementsDropdown({
  active,
  onSelect,
  useThai,
}: {
  active: Tab;
  onSelect: (t: Tab) => void;
  useThai: boolean;
}) {
  const isStatementActive = (STATEMENT_TABS as readonly Tab[]).includes(active);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={
          "inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded transition touch-manipulation outline-none " +
          (isStatementActive
            ? "bg-primary text-primary-foreground shadow"
            : "text-muted-foreground hover:bg-muted")
        }
      >
        <FileSpreadsheet className="h-4 w-4" />
        {useThai ? "งบการเงิน" : "Statements"}
        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        {STATEMENT_TABS.map((t) => (
          <DropdownMenuItem
            key={t}
            onClick={() => onSelect(t)}
            className={active === t ? "bg-accent text-accent-foreground" : ""}
          >
            {t === "tfrs"
              ? <FileSpreadsheet className="h-4 w-4" />
              : <Calculator className="h-4 w-4" />}
            {statementLabel(t, useThai)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
