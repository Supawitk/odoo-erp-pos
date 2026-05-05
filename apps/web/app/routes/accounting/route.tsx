import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { BookOpen, Calculator, FileBarChart, Info, Receipt } from "lucide-react";
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
        <div className="inline-flex items-center rounded-md border bg-background p-0.5 shadow-sm">
          <TabBtn value="trial-balance" active={tab} onClick={setTab}>
            <Calculator className="h-4 w-4" />
            {useThai ? "งบทดลอง" : "Trial balance"}
          </TabBtn>
          <TabBtn value="balance-sheet" active={tab} onClick={setTab}>
            <Calculator className="h-4 w-4" />
            {useThai ? "งบดุล" : "Balance sheet"}
          </TabBtn>
          <TabBtn value="profit-loss" active={tab} onClick={setTab}>
            <Calculator className="h-4 w-4" />
            {useThai ? "กำไรขาดทุน" : "P&L"}
          </TabBtn>
          <TabBtn value="cash-flow" active={tab} onClick={setTab}>
            <Calculator className="h-4 w-4" />
            {useThai ? "งบกระแสเงินสด" : "Cash flow"}
          </TabBtn>
          <TabBtn value="bank-rec" active={tab} onClick={setTab}>
            <Calculator className="h-4 w-4" />
            {useThai ? "กระทบยอดธนาคาร" : "Bank rec"}
          </TabBtn>
          <TabBtn value="fixed-assets" active={tab} onClick={setTab}>
            <Calculator className="h-4 w-4" />
            {useThai ? "สินทรัพย์ถาวร" : "Fixed assets"}
          </TabBtn>
          <TabBtn value="journal" active={tab} onClick={setTab}>
            <BookOpen className="h-4 w-4" />
            {useThai ? "บันทึกรายวัน" : "Journal"}
          </TabBtn>
          <TabBtn value="chart" active={tab} onClick={setTab}>
            <Receipt className="h-4 w-4" />
            {useThai ? "ผังบัญชี" : "Chart of accounts"}
          </TabBtn>
          {taxFilingsTabVisible && (
            <TabBtn value="tax-filings" active={tab} onClick={setTab}>
              <FileBarChart className="h-4 w-4" />
              ภาษี
            </TabBtn>
          )}
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
