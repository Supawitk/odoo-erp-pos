# Thai Accounting, VAT & Tax Knowledge Base

> Domain reference for building a Thai-compliant POS/ERP on NestJS 11 + React Native + React Router v7 + Odoo 18 + PostgreSQL 18.3.
> Last compiled: 2026-04-20. Statutory references are to the Thai Revenue Code (ประมวลรัษฎากร) unless otherwise stated. Where a claim could not be verified to an authoritative source, it is marked `(unverified — re-confirm)`.

---

## 1. Thai Tax Landscape Overview

### 1.1 Taxes that apply to a normal trading / restaurant / retail business

| Tax | Thai name | Who it hits in a POS context | Governing law |
|-----|----------|------------------------------|---------------|
| **VAT** | ภาษีมูลค่าเพิ่ม (ภ.พ.) | Every VAT-registered trader/restaurant/retail on most goods & services sales | Revenue Code §77/1–90/5 |
| **Corporate Income Tax (CIT)** | ภาษีเงินได้นิติบุคคล | Juristic persons (Co., Ltd., PCL, partnerships) on annual net profit | Revenue Code §65–76 |
| **Personal Income Tax (PIT)** | ภาษีเงินได้บุคคลธรรมดา | Sole proprietors, freelancers, non-registered shops | Revenue Code §40–64 |
| **Withholding Tax (WHT)** | ภาษีหัก ณ ที่จ่าย | Business as payer AND as payee — on services, rent, professional fees, dividends | Revenue Code §3 ter, §50, §69 ter, §70 |
| **Specific Business Tax (SBT)** | ภาษีธุรกิจเฉพาะ | Banking, finance, insurance, pawn shops, real-estate sale <5 yrs — NOT ordinary retail | Revenue Code §91/1–91/16 |
| **Stamp Duty** | อากรแสตมป์ | 28 instrument types: hire-purchase, loan, lease, service contract, share transfer | Revenue Code §103–129 |
| **Social Security** | ประกันสังคม (SSO) | Employers — 5% of gross salary capped at THB 15,000/mth (so max THB 750/employee/mth) | Social Security Act B.E. 2533 |
| **Excise Tax** | ภาษีสรรพสามิต | Alcohol, tobacco, sugar drinks — relevant for restaurants/bars | Excise Act B.E. 2560 |
| **Property/Land Tax** | ภาษีที่ดินและสิ่งปลูกสร้าง | Commercial-use premises owner | Land & Building Tax Act B.E. 2562 |

### 1.2 Regulators

| Agency | Scope | Website |
|--------|-------|---------|
| **RD — กรมสรรพากร (Revenue Department)** | VAT, CIT, PIT, WHT, SBT, Stamp Duty, e-Tax Invoice | [rd.go.th](https://www.rd.go.th/english/index-eng.html) |
| **ETDA — สำนักงานพัฒนาธุรกรรมทางอิเล็กทรอนิกส์** | Sets the XML standard ขมธอ.3-2560, time-stamp, digital-signature CA policy | [etda.or.th](https://www.etda.or.th) |
| **DBD — กรมพัฒนาธุรกิจการค้า** | Company registration, FS filing (XBRL via DBD e-Filing), audit rules | [dbd.go.th](https://www.dbd.go.th) |
| **TFAC — สภาวิชาชีพบัญชี (Federation of Accounting Professions)** | Issues TFRS and TFRS for NPAEs | [tfac.or.th](https://www.tfac.or.th) |
| **BoT — ธนาคารแห่งประเทศไทย (Bank of Thailand)** | Publishes the FX reference rates used for tax-point conversion; regulates PromptPay/QR | [bot.or.th](https://www.bot.or.th) |
| **SSO — สำนักงานประกันสังคม** | Payroll contributions (5% employer + 5% employee) | [sso.go.th](https://www.sso.go.th) |

### 1.3 Statutory Thresholds

| Threshold | Effect |
|-----------|--------|
| **Revenue > THB 1.8M / yr** | Must register for VAT within 30 days (§85/1). [gentlelawibl.com](https://www.gentlelawibl.com/post/thailand-vat-registration-2026-threshold-por-por-01-steps-pp-30-filing-and-sme-compliance-roadma) |
| **Paid-up capital ≤ THB 5M AND revenue ≤ THB 30M** | SME CIT rates apply (0/15/20%). [taxsummaries.pwc.com](https://taxsummaries.pwc.com/thailand/corporate/taxes-on-corporate-income) |
| **Revenue ≤ THB 30M / yr** | Eligible for the simplified **e-Tax Invoice by Email** programme. [kasikornglobalpayment.com](https://www.kasikornglobalpayment.com/en/news/detail/what-is-e-tax) |
| **Revenue > THB 200M / yr** | Must file Transfer Pricing Disclosure Form with PND.50. |
| **Hire of labour / freelance pay ≥ THB 1,000 per payment** | WHT applies at 3% for services (§3 ter). |

### 1.4 Statutory Filing Calendar (a typical year)

| Form | Cycle | Deadline | What |
|------|-------|----------|------|
| **PP.30 (ภ.พ.30)** | Monthly | 15th (paper) / 23rd (e-filing) of following month | VAT return |
| **PP.36 (ภ.พ.36)** | Monthly | 7th / 15th (e) of following month | Self-assessment VAT on imports-of-services / royalty to foreign |
| **PND.1 (ภ.ง.ด.1)** | Monthly | 7th / 15th (e) of following month | Employee payroll WHT |
| **PND.3 (ภ.ง.ด.3)** | Monthly | 7th / 15th (e) of following month | WHT on individuals (freelancers, landlords) |
| **PND.53 (ภ.ง.ด.53)** | Monthly | 7th / 15th (e) of following month | WHT on juristic persons |
| **PND.54 (ภ.ง.ด.54)** | Monthly | 7th / 15th (e) of following month | WHT to foreign entities |
| **PND.1 Kor (ภ.ง.ด.1ก)** | Annual | 28 February | Year-end employee payroll summary |
| **PND.51 (ภ.ง.ด.51)** | Half-year | 2 months after end of first half-year | Half-year CIT estimate |
| **PND.50 (ภ.ง.ด.50)** | Annual | 150 days after FY end | Full-year CIT return + audited FS |
| **DBD e-Filing (XBRL)** | Annual | 150 days after FY end | Audited financial statements to DBD |
| **SBT.40 (ภ.ธ.40)** | Monthly | 15th of following month | Specific Business Tax return |
| **Stamp Duty e-Stamp** | Per instrument | Within 15 days of execution | Via e-Stamp system since 2019 |

`[gentlelawibl.com/Thailand-PND-50-filing-2026](https://www.gentlelawibl.com/post/thailand-pnd-50-filing-2026-corporate-income-tax-return-checklist-for-foreign-smes)` · `[hlbthai.com/e-filing-of-pnd1-thailand](https://www.hlbthai.com/e-filing-of-pnd1-thailand/)`

---

## 2. VAT in Depth

### 2.1 Rate
- **Headline rate 7%** (currently). The Revenue Code §80 *base* rate is **10%**; the 7% rate has been extended by royal decree every 1–2 years since 1992 and must be checked each fiscal year for renewal.
- **0%** — zero-rated supplies (see §2.3).
- **Exempt** — outside VAT scope (see §2.3).

### 2.2 Input vs Output VAT

```
Output VAT (ภาษีขาย)  = VAT charged to customers on sales
Input VAT  (ภาษีซื้อ) = VAT paid to suppliers, recoverable
VAT payable = Output − Input  (if negative: carry forward or claim refund)
```

**Disallowed (non-creditable) input VAT categories** (§82/5 + Director-General notifications):

| Category | Rule |
|----------|------|
| Entertainment & hospitality | Not claimable as input (can be booked as CIT expense with caveats). [forvismazars.com/VAT](https://www.forvismazars.com/th/en/insights/doing-business-in-thailand/tax/value-added-tax-vat-in-thailand) |
| Passenger car ≤ 10 seats — purchase, hire-purchase, lease, repair, fuel | Not claimable (exception: car-rental, tour, driving-school businesses) |
| Tax invoice with defects (missing any §86/4 field) | Not claimable |
| Tax invoice issued by non-VAT-registered person | Not claimable |
| Tax invoice with buyer TIN wrong or missing | Not claimable — critical POS validation point |
| Input related to exempt supplies | Not claimable (pro-rate if mixed) |
| Tax invoice older than **6 months from tax-point month** | **Not claimable — see §2.7** |

### 2.3 Zero-rated vs Exempt

**Zero-rated (0%) — §80/1** — VAT-registered, can claim input:
- Export of goods (BoE customs-cleared)
- International transport (air, sea)
- Services performed in Thailand but used abroad
- Goods/services to UN agencies, embassies
- Sales between bonded warehouses / free-trade-zone operators

**Exempt — §81** — outside VAT, cannot claim input:
- Unprocessed agricultural products, animal feed, fertiliser, pesticides
- Newspapers, magazines, textbooks
- Healthcare, education (government + private schools)
- Libraries, museums, zoos
- Domestic land-transport of passengers
- Research & academic services
- Religious / charitable services
- Sale/rent of immovable property
- Small businesses < THB 1.8M/yr (default exemption unless they opt-in)

`[siam-legal.com/VAT-exemption](https://library.siam-legal.com/thai-law/revenue-code-value-added-tax-exemption-section-81/)` · `[forvismazars.com/VAT](https://www.forvismazars.com/th/en/insights/doing-business-in-thailand/tax/value-added-tax-vat-in-thailand)`

### 2.4 Tax Point (time of supply) — §78 & §78/1

| Scenario | Tax point |
|----------|-----------|
| Sale of tangible goods | Earliest of: delivery, transfer of ownership, payment received, tax invoice issued |
| Services | Earliest of: payment received, service rendered, tax invoice issued |
| Deposit / advance payment on services | When deposit received (VAT on the deposit) |
| Hire-purchase / instalment | When each instalment is due |
| Consignment | When consignee sells to end-customer |
| Import of goods | When import duty paid |
| Import of services (reverse charge via PP.36) | When payment remitted abroad |

**POS implication**: since retail sales are almost always paid at checkout, the tax point = checkout timestamp. **Issuance of tax invoice** itself creates a tax point even if no cash received — POS must never issue "draft" tax invoices that escape into the numbered sequence.

`[rd.go.th/section77-79](https://www.rd.go.th/english/37719.html)`

### 2.5 Registration Path (Por.Por.01)

1. Threshold crossed → 30 days to file **ภ.พ.01** (Por.Por.01).
2. Supporting documents: DBD corporate cert, Memorandum of Association, shareholder list, lease agreement for physical premises (must be real address — RD site-inspects), ID + house registration of directors, map to office.
3. Optional voluntary registration before threshold — useful if most customers are companies that need input-VAT credit.
4. Certificate **ภ.พ.20** (Por.Por.20) issued — this 13-digit VAT ID must be printed on every tax invoice. (VAT ID = TIN for juristic persons.)
5. Branches each need a **5-digit branch code** on ภ.พ.09 (Por.Por.09) filing, required on tax invoices (§86/4(2)).

### 2.6 PP.30 Monthly Return

Deadline: **15th** of following month (paper) / **23rd** (e-filing via rd.go.th). Filing required even for zero activity. Revised form begins use **1 March 2026** per RD notification. [gentlelawibl.com](https://www.gentlelawibl.com/post/thailand-vat-registration-2026-threshold-por-por-01-steps-pp-30-filing-and-sme-compliance-roadma)

**PP.30 boxes (conceptual — re-confirm against 2026 form)**:

| Box | Content |
|-----|---------|
| 1 | Total sales for the tax month |
| 2 | Zero-rated sales |
| 3 | Exempt sales |
| 4 | Taxable sales (Box 1 − 2 − 3) |
| 5 | Output VAT (Box 4 × 7%) |
| 6 | Input VAT this month |
| 7 | VAT payable / refundable (Box 5 − Box 6) |
| 8 | Penalty (if filed late) |
| 9 | Surcharge 1.5%/mth |
| 10 | VAT carry-forward from prior month |
| 11 | Net cash to pay |

### 2.7 Input/Output VAT Reports (Rai-ngan Phasi Sue / Rai-ngan Phasi Khai)

Mandatory monthly ledgers per **§87**:

- **Report of Sales Tax** (รายงานภาษีขาย) — every output tax invoice issued, chronologically.
- **Report of Purchase Tax** (รายงานภาษีซื้อ) — every input tax invoice received.
- **Inventory & Goods Report** (รายงานสินค้าและวัตถุดิบ) — daily receipts/issues of inventory.

**Required columns** (both sales & purchase VAT reports — unverified minor variations — re-confirm):

| Col | Field |
|-----|-------|
| 1 | Running line number |
| 2 | Date of tax invoice |
| 3 | Tax invoice number (+book number if any) |
| 4 | Counterparty name |
| 5 | Counterparty TIN |
| 6 | Counterparty branch code |
| 7 | Net value (ex-VAT) |
| 8 | VAT amount |
| 9 | Grand total |
| 10 | Remark (e.g., zero-rated, exempt, debit/credit note ref) |

Must be kept in binder form (or equivalent digital record) and **printed out by the 15th of the following month** in the classic interpretation — modern RD practice accepts fully electronic binders if they comply with DBD/RD e-record rules (see §8 below).

### 2.8 Input VAT 6-Month Rule — Critical

Per Director-General Notification on VAT (No. 4, as amended): an input tax invoice may be claimed **either in the tax-point month OR in any of the following 6 calendar months**. After 6 months → **permanently lost** (cannot be offset, can only be booked as a CIT expense if conditions met). [avalara.com/Thailand-VAT-Guide](https://www.avalara.com/us/en/vatlive/country-guides/asia/thailand.html)

**Implementation watch**: store `invoice_tax_point_date` and compute `claim_expiry = tax_point + 6 calendar months`; a BullMQ daily job should surface invoices crossing expiry for automatic reversal / CIT expense re-class.

### 2.9 Penalties & Surcharges

| Violation | Penalty |
|----------|---------|
| Late filing of PP.30 | **THB 300** if filed within 7 days late, **THB 500** after 7 days (cash only) [thailand.go.th](https://www.thailand.go.th/issue-focus-detail/007_057) |
| Late VAT payment | Surcharge **1.5% per month** of VAT due (capped at 100% of tax) |
| No filing / under-reporting upon RD summons | Fine = **1× to 2× the tax due** (§89) |
| Issuing tax invoice without being registered | Fine up to THB 200,000 |
| Fake / fraudulent tax invoice | Imprisonment 3 months – 7 years, fine THB 2,000 – 200,000 |
| No input VAT report or output VAT report | Fine THB 2,000 per instance |

---

## 3. Tax Invoice vs Receipt vs Invoice

### 3.1 Legal definitions
- **Tax Invoice (ใบกำกับภาษี)** — §86: document proving VAT charged; entitles *registered* buyer to input VAT claim.
- **Abbreviated Tax Invoice (ใบกำกับภาษีอย่างย่อ)** — §86/6: simplified format for approved retail businesses issuing to end-consumers.
- **Receipt (ใบเสร็จรับเงิน)** — proof of payment. Only mandatory field is "paid amount"; not by itself a tax invoice.
- **Invoice / Bill (ใบแจ้งหนี้)** — commercial invoice; carries no tax-law weight by itself.
- Many Thai businesses combine them: **ใบกำกับภาษี / ใบเสร็จรับเงิน** on the same form — legally valid and preferred.

### 3.2 Mandatory fields — FULL Tax Invoice (§86/4)

1. The word **"ใบกำกับภาษี"** must appear prominently (literal mandatory header).
2. Seller's name, address, **TIN (13-digit)**, branch code (5-digit, e.g. `00000` for head office).
3. Buyer's name, address; buyer's TIN + branch code **if buyer is VAT-registered**.
4. Sequential tax-invoice number; book number if using books.
5. Issue date.
6. Description, type, category, quantity, unit price of goods/services.
7. VAT amount **shown separately** from ex-VAT value.
8. Total.
9. Any other items the Director-General requires (e.g., "ต้นฉบับ / สำเนา" copy marking).

Language: Thai mandatory; English may appear in parallel. Currency: THB mandatory (secondary currency allowed — see §9.11). Numerals: Thai or Arabic digits both accepted. [rd.go.th/section85-86](https://www.rd.go.th/english/37741.html) · [siam-legal.com/section86](https://library.siam-legal.com/thai-law/revenue-code-tax-invoice-debit-note-credit-note-section-86/)

### 3.3 ABBREVIATED Tax Invoice (§86/6, Director-General Reg. Por.86/2542)

Retailers who sell to end-consumers and who obtain RD approval can issue abbreviated tax invoices (think of supermarket / convenience-store / food-court POS receipts).

**Required fields (minimum)**:
1. The words **"ใบกำกับภาษีอย่างย่อ"** — or at minimum "ใบกำกับภาษี" — header.
2. Seller abbreviated name + TIN.
3. Sequential number.
4. Issue date.
5. Item description (type may be abbreviated / use codes with legend stored).
6. Price **including VAT**, annotated that VAT is included.

**Omittable vs full**: buyer details, book number, separate VAT line (as long as it says "VAT included").

**Threshold**: abbreviated format is typically limited to retail invoices `≤ THB 1,000` in practice (unverified — re-confirm from Por.86/2542 annex), though the law is phrased around retail-to-consumer rather than an exact baht cap. Above threshold or when buyer presents TIN → issue FULL format. [flowaccount.com/ABB](https://flowaccount.com/blog/abbreviated-tax-invoice-in-thailand/)

### 3.4 Credit Note (ใบลดหนี้) §86/10 / Debit Note (ใบเพิ่มหนี้) §86/9

Issue when value changes after the original tax invoice for reasons in §82/9–§82/10:
- Return of goods, price reduction, post-sale discount, cancelled service → **credit note**.
- Price increase, additional quantity, correction upward → **debit note**.

Must include:
- Reference to the **original tax invoice number + date**.
- Original value, new value, delta, VAT delta.
- Same mandatory field set as a tax invoice (seller/buyer/TIN/date/seq).
- Marked prominently as "ใบลดหนี้" or "ใบเพิ่มหนี้".

Both count as tax invoices for buyer's input and seller's output adjustment — they go into the VAT reports of the month issued (not back-dated).

### 3.5 Numbering & Prefix Conventions (observed in Thai POS)

There is no statutory required prefix — only "sequential and unique". Common conventions:

| Prefix | Doc |
|--------|-----|
| `IV-YYMM-#####` | Invoice |
| `TX-YYMM-#####` | Tax Invoice (full) |
| `ABB-YYMM-#####` or `POS-YYMM-#####` | Abbreviated tax invoice |
| `RE-YYMM-#####` or `RC-YYMM-#####` | Receipt |
| `CN-YYMM-#####` | Credit Note |
| `DN-YYMM-#####` | Debit Note |
| Branch-scoped: `{BR}-TX-YYMM-#####` | e.g. `0001-TX-2604-00123` |

Critical rule: **no gaps**. If POS voids a draft, keep the number as `VOID` entry rather than skip — RD audits flag gaps.

### 3.6 Language Rules
Thai mandatory in every mandatory field. Parallel English allowed (common in B2B). Arabic or Thai digits OK. If only English used → invalid for RD filing purposes → buyer loses input VAT.

---

## 4. e-Tax Invoice & e-Receipt — The Electronic Regime

### 4.1 Two Programmes

| Programme | Audience | Format | Sign | Store |
|-----------|----------|--------|------|-------|
| **(a) e-Tax Invoice & e-Receipt (full)** | Any VAT-registered business | XML (ขมธอ.3-2560) + optional PDF/A-3 | XAdES-BES digital signature with CA cert | Submit to RD by 15th |
| **(b) e-Tax Invoice by Email** | Revenue ≤ THB 30M/yr, VAT-registered | PDF/A-3 | ETDA Time-Stamp | Email to buyer + CC `csemail@etax.teda.th` |

[kasikornglobalpayment.com/what-is-e-tax](https://www.kasikornglobalpayment.com/en/news/detail/what-is-e-tax) · [grantthornton.co.th](https://www.grantthornton.co.th/insights/e-tax/)

### 4.2 ETDA Standard ขมธอ.3-2560 (ICT Standard Recommendation 3-2560)

- XML profile of **UN/CEFACT CrossIndustryInvoice v9.1** (not UBL 2.1 — the earlier literature sometimes conflates the two; the *actual* schema is CrossIndustryInvoice, often colloquially still referred to as "UBL-compatible"). Schemas live at [schemas.teda.th](https://schemas.teda.th/teda/teda-objects/common/e-tax-invoice-receipt/-/blob/master/ETDA/data/standard/TaxInvoice_CrossIndustryInvoice_2p0.xsd).
- Covers: **Invoice, TaxInvoice, DebitNote, CreditNote, Receipt, CancellationNote**.
- File extension `.xml`, UTF-8, XAdES-BES enveloped signature.

#### High-level CrossIndustryInvoice structure (abridged)

```
<rsm:CrossIndustryInvoice>
  <rsm:ExchangedDocumentContext>
    <ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>T02</ram:ID>                  <!-- T02=tax invoice, T03=credit, T04=debit -->
    </ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:etda:iccs:std:CrossIndustryInvoice:2.0</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>

  <rsm:ExchangedDocument>
    <ram:ID>TX-2604-00001</ram:ID>          <!-- our sequential number -->
    <ram:Name>ใบกำกับภาษี</ram:Name>
    <ram:TypeCode>388</ram:TypeCode>        <!-- UN/CEFACT doc type -->
    <ram:IssueDateTime><udt:DateTimeString format="102">20260420</udt:DateTimeString></ram:IssueDateTime>
    <ram:LanguageID>th</ram:LanguageID>
  </rsm:ExchangedDocument>

  <rsm:SupplyChainTradeTransaction>
    <!-- Seller -->
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:ID>0105551234567</ram:ID>       <!-- 13-digit TIN -->
        <ram:Name>บริษัท ABC จำกัด</ram:Name>
        <ram:PostalTradeAddress>...</ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="TXID">0105551234567</ram:ID>
          <ram:ID schemeID="BRN">00000</ram:ID>    <!-- branch -->
        </ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>

      <!-- Buyer -->
      <ram:BuyerTradeParty>
        <ram:ID>0107537000254</ram:ID>
        <ram:Name>บริษัท XYZ จำกัด (มหาชน)</ram:Name>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="TXID">0107537000254</ram:ID>
          <ram:ID schemeID="BRN">00001</ram:ID>
        </ram:SpecifiedTaxRegistration>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>

    <!-- Line items (repeat) -->
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>ข้าวไข่เจียว</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount currencyID="THB">50.00</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="C62">2</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>   <!-- S=standard 7, Z=zero, E=exempt -->
          <ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>

    <!-- Totals + tax breakdown -->
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>THB</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount currencyID="THB">7.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount currencyID="THB">100.00</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount currencyID="THB">100.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount currencyID="THB">100.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="THB">7.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount currencyID="THB">107.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount currencyID="THB">107.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>

  <!-- Signature -->
  <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">...</ds:Signature>
</rsm:CrossIndustryInvoice>
```

### 4.3 Digital Signature Requirements

- **XAdES-BES** envelope signature (XML Advanced Electronic Signature, Basic Electronic Signature profile).
- Private key in **HSM** or **USB token (PKCS#11)**; software keystore (PKCS#12) also accepted for small issuers.
- Cert issued by an **RD/ETDA-recognised CA**:
  - **Thai Digital ID** (TDID) — dominant for SMEs.
  - **Internet Thailand (INET) CA**.
  - **TOT CA**.
  - **Thai National Root CA** is the root of trust.
- Reference implementation: **[ETDA/etax-xades](https://github.com/ETDA/etax-xades)** (Java, official sample). [github.com/ETDA/etax-xades](https://github.com/ETDA/etax-xades)

### 4.4 Submission Channels

| Channel | Description | Suits |
|---------|-------------|-------|
| **Upload XML** (manual) | Log in to [etax.rd.go.th](https://etax.rd.go.th/), upload signed XML bundles | Low volume, monthly batch |
| **Service Provider (ASP)** | ASP signs & transmits on your behalf via their REST API | Most SMEs |
| **Host-to-Host (H2H)** | Direct ebXML/ขมธอ.14-2560 over MPLS private circuit | Large enterprises with huge volume |

Monthly submission to RD: by **15th** of the following month.

### 4.5 ETDA Time-Stamping Authority

Used mainly by the **e-Tax Invoice by Email** programme. The email with PDF/A-3 attachment is CC'd to `csemail@etax.teda.th`; ETDA replies with a timestamp-signed PDF confirming receipt time. The timestamped reply is the legal proof of issuance. Cost: currently free for eligible small businesses (unverified — re-confirm with current ETDA pricing).

### 4.6 Retention

- **5 years** minimum (Revenue Code §87/3), extendable to **7 years** by RD order.
- For e-Tax: store the **signed XML + any RD acknowledgement receipt** — not a rendered PDF by itself.
- Store plus integrity-proof (hash or chained timestamp) so audit can verify no tampering.

### 4.7 Enrolment Path to become an "ผู้ออกใบกำกับภาษีอิเล็กทรอนิกส์"
1. Apply via [etax.rd.go.th](https://etax.rd.go.th/) — file form ภ.อ.01.
2. Obtain CA-issued digital certificate first.
3. RD reviews within 30 days.
4. Approval letter + enables XML upload and H2H slots.

---

## 5. Withholding Tax (WHT)

### 5.1 When must the payer withhold?
When a juristic person (or SME sole prop paying ≥ THB 1,000 per payment event) pays:

| Payment type | Rate | Payee = individual (file with…) | Payee = juristic person (file with…) |
|--------------|------|---------------------------------|--------------------------------------|
| Services (e.g. cleaning, IT, consulting) | **3%** | PND.3 | PND.53 |
| Professional fees (doctor, lawyer, accountant) | **3%** | PND.3 | PND.53 |
| Rent of building/office/equipment | **5%** | PND.3 | PND.53 |
| Advertising | **2%** | PND.3 | PND.53 |
| Freight/transport | **1%** | PND.3 | PND.53 |
| Hire of work (contractor) | **3%** | PND.3 | PND.53 |
| Commissions/brokerage | **3%** | PND.3 | PND.53 |
| Prize/gambling | **5%** | PND.3 | PND.53 |
| Dividends to individuals | **10%** | PND.2 | n/a |
| Interest to individuals | **15%** | PND.2 | n/a |
| Interest to foreign entity | **15%** | n/a | PND.54 |
| Service fees to foreign entity (no PE in TH) | **15%** | n/a | PND.54 |
| Dividends to foreign entity | **10%** | n/a | PND.54 |
| Royalty / know-how | **3%** TH / **15%** foreign | PND.3 | PND.53 / PND.54 |

[benoit-partners.com/withholding](https://benoit-partners.com/thai-withholding-tax/) · [vbapartners.com/pnd-forms](https://vbapartners.com/thailand-tax-submission-pnd-forms-filing-secrets/)

### 5.2 Payroll Withholding (PND.1)
- Progressive PIT rates 0-35% applied on projected annual salary, then divided by pay periods.
- Filing: monthly **PND.1**, annual summary **PND.1 Kor** due 28 Feb.
- Mandatory e-filing since 2024. [hlbthai.com](https://www.hlbthai.com/e-filing-of-pnd1-thailand/)

### 5.3 Form 50 Tawi — Withholding Tax Certificate (หนังสือรับรองการหักภาษี ณ ที่จ่าย / ใบ 50 ทวิ)

Required under §50 bis, two copies:
- **Copy 1** → payee (used when they file their own tax return).
- **Copy 2** → payer retains for 5 years.

Mandatory fields:
- Payer name, address, TIN.
- Payee name, address, TIN / ID.
- Payment type (salary, service, rent, etc.).
- Gross amount, WHT rate, WHT amount.
- Date of payment, date of WHT.
- Certificate sequential number.
- Signature of payer or authorised person.

Template PDF: [rd.go.th/frm_WTC.pdf](https://www.rd.go.th/fileadmin/download/english_form/frm_WTC.pdf)

### 5.4 Filing Deadline
- **7th** of following month (paper).
- **15th** of following month (e-filing via RD).
- Annual PND.1 Kor: **28 February**.

### 5.5 POS/ERP handling
Most POS sales don't involve WHT (end-consumer retail). But:
- **AP (Accounts Payable) side**: when the ERP pays a vendor for service/rent, the system must create the WHT journal line AND generate the 50-Tawi PDF for print.
- **AR (Accounts Receivable) side**: when a customer (another company) pays the merchant, they often withhold 3% and send their 50-Tawi back; the ERP must record that withholding as a WHT-receivable asset to be offset against the merchant's annual PND.50 CIT liability.

---

## 6. Corporate Income Tax (CIT)

### 6.1 Rates

**SME** (paid-up capital ≤ THB 5M **AND** revenue ≤ THB 30M):

| Net profit | Rate |
|-----------|------|
| 0 – 300,000 | **0%** (exempt) |
| 300,001 – 3,000,000 | **15%** |
| > 3,000,000 | **20%** |

**Non-SME**: flat **20%** on net profit.

[taxsummaries.pwc.com](https://taxsummaries.pwc.com/thailand/corporate/taxes-on-corporate-income) · [gentlelawibl.com](https://www.gentlelawibl.com/post/thailand-pnd-50-filing-2026-corporate-income-tax-return-checklist-for-foreign-smes)

### 6.2 Forms
- **PND.51** — half-year estimate: 2 months after end of first half-year (≈ end of August for Jan–Dec FY).
- **PND.50** — full-year return + audited FS: **150 days** after FY end.

### 6.3 Major Deductible / Non-Deductible Rules
- **Entertainment cap** — max THB 10,000 per event AND ≤ 0.3% of revenue or capital (whichever higher), max THB 10M/yr.
- **Depreciation** — straight-line by asset class: 20% buildings, 20% machinery, 20% vehicles, 100% for low-cost (< THB 20K) tools. Computer software 20%. Initial allowance rules for SMEs (up to 40% first-year deduction).
- **Donations** — capped at 2% of net profit.
- **Loss carry-forward** — 5 accounting periods (§65 ter(12)).
- **Interest on loans from shareholders** — must not exceed market rate.
- **Provision for bad debts** — only after statutory write-off procedure (§65 bis(9)).
- **Transfer Pricing** — if revenue > THB 200M, must file **Transfer Pricing Disclosure Form** with PND.50 per §71 bis.

---

## 7. Chart of Accounts Aligned to TFRS for NPAEs

### 7.1 Standard applied
TFRS for NPAEs (ปรับปรุง 2565/2022) effective 1 Jan 2023, issued by **TFAC** (สภาวิชาชีพบัญชี). Most SMEs apply NPAEs; PAEs (listed companies) apply full TFRS ≈ IFRS. [forvismazars.com/NPAE](https://www.forvismazars.com/th/en/insights/doing-business-in-thailand/accounting/revised-tfrs-for-npaes-effective)

### 7.2 Account-code convention

Thai SMEs commonly use a **4-digit account code** with the first digit = statement class:

| First digit | Class | TH |
|------------|-------|-----|
| 1 | Assets | สินทรัพย์ |
| 2 | Liabilities | หนี้สิน |
| 3 | Equity | ส่วนของผู้ถือหุ้น |
| 4 | Revenue | รายได้ |
| 5 | Cost of Goods Sold | ต้นทุนขาย |
| 6 | Operating Expenses | ค่าใช้จ่ายในการขายและบริหาร |
| 7 | Other Income | รายได้อื่น |
| 8 | Other Expense | ค่าใช้จ่ายอื่น |

### 7.3 Proposed Thai SME Default Chart of Accounts (to seed in `custom.chart_of_accounts`)

| Code | Thai name | English name | Normal Balance | Note |
|------|-----------|--------------|---------------|------|
| 1110 | เงินสด | Cash on hand | Debit | Cash drawer |
| 1120 | เงินฝากธนาคาร - กระแสรายวัน | Bank - current | Debit | Per bank account one sub-acct |
| 1121 | เงินฝากธนาคาร - ออมทรัพย์ | Bank - savings | Debit | |
| 1130 | ลูกหนี้การค้า | Accounts receivable | Debit | |
| 1131 | ค่าเผื่อหนี้สงสัยจะสูญ | Allowance for doubtful accts | Credit | Contra-asset |
| 1140 | สินค้าคงเหลือ | Inventory | Debit | |
| 1150 | ค่าใช้จ่ายจ่ายล่วงหน้า | Prepaid expenses | Debit | |
| 1155 | **ภาษีซื้อ** | **Input VAT (claimable this month)** | Debit | **MANDATORY** |
| 1156 | **ภาษีซื้อยังไม่ถึงกำหนด** | **Deferred input VAT** | Debit | **MANDATORY** — for invoices received but tax point not yet |
| 1157 | **ภาษีถูกหัก ณ ที่จ่าย** | **WHT receivable (ours, held by customers)** | Debit | Offset against annual CIT |
| 1160 | ลูกหนี้กรมสรรพากร | VAT refund receivable | Debit | |
| 1210 | ที่ดิน | Land | Debit | |
| 1220 | อาคาร | Buildings | Debit | |
| 1221 | ค่าเสื่อมสะสม - อาคาร | Acc. depr. - buildings | Credit | Contra |
| 1230 | เครื่องจักรและอุปกรณ์ | Machinery & equipment | Debit | |
| 1231 | ค่าเสื่อมสะสม - เครื่องจักร | Acc. depr. - machinery | Credit | Contra |
| 1240 | ยานพาหนะ | Vehicles | Debit | |
| 1250 | เครื่องตกแต่งสำนักงาน | Office furniture | Debit | |
| 1260 | คอมพิวเตอร์และซอฟต์แวร์ | Computers & software | Debit | |
| 2110 | เจ้าหนี้การค้า | Accounts payable | Credit | |
| 2120 | เงินกู้ยืมระยะสั้น | Short-term loans | Credit | |
| 2130 | ค่าใช้จ่ายค้างจ่าย | Accrued expenses | Credit | |
| 2140 | เงินรับล่วงหน้า | Unearned revenue | Credit | |
| 2201 | **ภาษีขาย** | **Output VAT** | Credit | **MANDATORY** |
| 2202 | **ภาษีขายยังไม่ถึงกำหนด** | **Deferred output VAT** | Credit | For service invoices, tax point = payment |
| 2203 | **ภาษีหัก ณ ที่จ่ายค้างจ่าย** | **WHT payable** | Credit | Remit on PND.3/53 |
| 2204 | ภาษีเงินได้นิติบุคคลค้างจ่าย | CIT payable | Credit | |
| 2205 | ประกันสังคมค้างจ่าย | SSO payable | Credit | |
| 2210 | เงินกู้ยืมระยะยาว | Long-term loans | Credit | |
| 3110 | ทุนจดทะเบียน | Registered capital | Credit | DBD-registered amount |
| 3120 | ทุนชำระแล้ว | Paid-up capital | Credit | |
| 3130 | สำรองตามกฎหมาย | Legal reserve | Credit | Required (5% of profit until 10% of capital) |
| 3140 | กำไรสะสม | Retained earnings | Credit | |
| 4110 | รายได้จากการขาย | Sales revenue | Credit | |
| 4120 | รายได้จากการบริการ | Service revenue | Credit | |
| 4130 | ส่วนลดจ่าย | Sales discounts | Debit | Contra-revenue |
| 4140 | รับคืนสินค้า | Sales returns | Debit | Contra-revenue |
| 5110 | ต้นทุนขาย | Cost of goods sold | Debit | |
| 5120 | ต้นทุนบริการ | Cost of services | Debit | |
| 6110 | เงินเดือน | Salaries & wages | Debit | |
| 6120 | ค่าเช่า | Rent | Debit | |
| 6130 | ค่าสาธารณูปโภค | Utilities | Debit | |
| 6140 | ค่าโฆษณา | Advertising | Debit | |
| 6150 | ค่ารับรอง | Entertainment (capped) | Debit | Watch §65 ter cap |
| 6160 | ค่าเสื่อมราคา | Depreciation expense | Debit | |
| 6170 | ค่าธรรมเนียมธนาคาร | Bank charges | Debit | |
| 6180 | ค่าใช้จ่ายเบ็ดเตล็ด | Miscellaneous | Debit | |
| 7110 | ดอกเบี้ยรับ | Interest income | Credit | |
| 7120 | กำไรจากอัตราแลกเปลี่ยน | FX gain | Credit | |
| 8110 | ดอกเบี้ยจ่าย | Interest expense | Debit | |
| 8120 | ขาดทุนจากอัตราแลกเปลี่ยน | FX loss | Debit | |
| 8210 | ภาษีเงินได้นิติบุคคล | CIT expense | Debit | |

---

## 8. Accounting Books & Records

### 8.1 Legal basis
- **Accounting Act B.E. 2543 (2000)** — principal statute, administered by DBD.
- **Civil & Commercial Code** — partnership/company obligations.
- **Revenue Code §87–87/3** — tax-records retention.

### 8.2 Mandatory Books

| Book | TH | Frequency |
|------|-----|-----------|
| Journal (general + special) | สมุดรายวัน | Daily |
| General Ledger | บัญชีแยกประเภท | Monthly posting |
| Sales VAT Report | รายงานภาษีขาย | Monthly |
| Purchase VAT Report | รายงานภาษีซื้อ | Monthly |
| Inventory & Goods Report | รายงานสินค้าและวัตถุดิบ | **Daily (receipts/issues)** — key pain point for retail |
| Cash book | สมุดเงินสด | Daily |
| Fixed-asset register | ทะเบียนทรัพย์สิน | Event-driven |

### 8.3 Retention
- **5 years** (Revenue Code §87/3).
- Extendable to **7 years** by RD order (certain audit cases).
- Accounting Act B.E. 2543: also **5 years** from closing date. [benoit-partners.com/accounting](https://benoit-partners.com/accounting-thailand/) · [msnagroup.com/thai-accounting-law](https://msnagroup.com/thai-accounting-tax/thai-accounting-law/)

### 8.4 Language & Currency
- Books in **Thai** (foreign language acceptable only with certified Thai translation).
- Currency: **THB**. Foreign-currency txns must be converted at BoT reference rate (see §9.11).
- Presentation currency of FS: THB (for TFRS for NPAEs mandatory).

### 8.5 Electronic Books
DBD allows fully electronic books if they comply with:
- Retrievability: can be printed within a reasonable time from RD audit request.
- Integrity: typically digital signature or hash-chain.
- Control: access logs, segregation.
- Approved file formats: PDF/A, XML, CSV.

### 8.6 Annual FS & Audit
- Licensed Thai **CPA (TA or CPA-auditor)** must audit financial statements for all limited companies regardless of size.
- FS filed with DBD via **e-Filing XBRL** system within **150 days** of FY end.
- Shareholder AGM approval required before DBD filing.
- DBD has been paperless since 2015. [pricesanond.com](https://www.pricesanond.com/knowledge/corporate-m-and-a/dbd-goes-paperless-for-financial-statement-filings.php)

---

## 9. Integration With Our Stack

Each item below maps to the hexagonal module structure of the API gateway.

### 9.1 POS Receipt vs Tax-Invoice Printing Rules

**State machine at checkout (owned by `modules/pos/application`):**

```
┌─────────────────┐
│ Order confirmed │
└────────┬────────┘
         ▼
   customer TIN entered? ────NO──► print ABBREVIATED TX (§86/6) — seq ABB-…
         │YES
         ▼
   TIN valid (13-digit + checksum)?
         │NO ──► reject, prompt correction
         │YES
         ▼
   total ≤ THB 1,000 AND customer opted abbreviated?
         │YES ──► print ABBREVIATED
         │NO
         ▼
   print FULL TX (§86/4) — seq TX-… — requires name, branch code, address
```

**iPad POS data to collect when customer requests full tax invoice:**

| Field | Required | Validation |
|-------|----------|-----------|
| TIN (13 digits) | Yes | Mod-11 checksum (see §9.2) |
| Branch code | Yes (default `00000` = HQ) | Exactly 5 digits |
| Legal name (with prefix) | Yes | Must include "บริษัท", "ห้างหุ้นส่วนจำกัด", "ร้าน", or personal name |
| Address | Yes | Free text, Thai preferred |
| Phone | Optional | |
| Email (for e-Tax delivery) | Optional | RFC 5321 |

### 9.2 TIN Validation Algorithm

The 13th digit is a **mod-11 checksum** of the first 12:

```
sum = Σ (digit[i] × (13 − i))  for i in 0..11
check = (11 − (sum % 11)) % 10
valid if check == digit[12]
```

Reject invalid TINs at input. [taxdo.com/thailand](https://taxdo.com/resources/global-tax-id-validation-guide/thailand) · [tin-check.com](https://tin-check.com/en/thailand/)

### 9.3 Journal Entry Mapping from POS Sale

**Cash sale, VAT-registered, item THB 100 + 7% VAT, 2 units → THB 214**

```
Dr  1110 Cash                    214.00
      Cr  4110 Sales revenue           200.00
      Cr  2201 Output VAT               14.00
```

**Card sale — same amount**

```
Dr  1120 Bank (pending settlement)   214.00
      Cr  4110 Sales revenue            200.00
      Cr  2201 Output VAT                14.00
```
Upon Stripe/bank settlement (net of fee):

```
Dr  1120 Bank                        210.00
Dr  6170 Bank charges                  4.00
      Cr  1120 Bank (pending)           214.00
```

**PromptPay QR** — same as cash once confirmed by webhook.

**Refund (full)**

```
Dr  4140 Sales returns              200.00
Dr  2201 Output VAT                  14.00
      Cr  1110 Cash                      214.00
```
Must also issue a **Credit Note** (§86/10) referencing the original tax-invoice number.

**Void (same day, before batch close)** — simply mark the sale `voided=true`, do NOT post journal, but **keep the tax invoice number** with `VOID` stamp so the sequence has no gaps.

### 9.4 Withholding Tax Capture on AP

Vendor bill: service THB 10,000 + 7% VAT = 10,700, WHT 3% = 300.

```
Dr  6110 Service expense            10,000.00
Dr  1155 Input VAT                     700.00
      Cr  2110 Accounts payable         10,400.00
      Cr  2203 WHT payable                 300.00
```
On payment:
```
Dr  2110 Accounts payable           10,400.00
      Cr  1120 Bank                     10,400.00
```
System auto-generates **50-Tawi PDF** (sequence number, vendor details, WHT type). Filed in PND.3 / PND.53 by 7th of next month.

### 9.5 e-Tax Invoice Submission Pipeline

Module: `modules/etax` (new). Hexagonal split:

```
domain/
  entities/e-tax-document.entity.ts      (Invoice, TaxInvoice, CreditNote, DebitNote, Receipt)
  value-objects/etax-status.vo.ts        (pending, signed, submitted, acknowledged, rejected)
  events/etax-submitted.event.ts

application/
  commands/
    generate-etax-xml.handler.ts
    sign-etax-xml.handler.ts
    submit-etax.handler.ts
  services/
    etax-batcher.service.ts              (groups by tax-month, kicks off submission by 15th)

infrastructure/
  adapters/
    etda-xml-builder.adapter.ts          (builds CrossIndustryInvoice XML)
    xades-signer.adapter.ts              (wraps xmldsig / xadesjs / node-forge; or calls a Java microservice using ETDA/etax-xades)
    leceipt-api.adapter.ts               (ASP option 1)
    inet-etax-api.adapter.ts             (ASP option 2)
    rd-direct-submission.adapter.ts      (direct upload to etax.rd.go.th, long-term)
    time-stamp-etda.adapter.ts           (for e-Tax by Email)

persistence/
  etax-document.schema.ts
  etax-submission-log.schema.ts
```

**BullMQ queue `etax-submission`** — daily at 02:00:
1. Query all posted tax invoices/credit/debit notes of the previous calendar day with `etax_status='pending'`.
2. Build XML per CrossIndustryInvoice 2.0.
3. Sign via XAdES-BES (certificate from Vault).
4. Submit to ASP or RD.
5. Store `submission_id`, `ack_timestamp`, `rd_reference` on the document row.
6. Any failed row → retry with exponential backoff, alert after 3 attempts.

**SQL suggestion for submission log:**

```sql
CREATE TABLE custom.etax_submission_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES custom.tax_invoices(id),
  document_type   text NOT NULL,                  -- T01..T05
  submission_method text NOT NULL,                -- 'direct','ASP:leceipt','ASP:inet','email'
  xml_content     bytea,
  xml_hash_sha256 bytea,
  signature_algo  text,
  signed_at       timestamptz,
  submitted_at    timestamptz,
  rd_reference    text,                           -- RD ack number
  status          text NOT NULL,                  -- 'pending','signed','submitted','acknowledged','rejected'
  rejection_reason text,
  retry_count     int DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX etax_log_status_idx ON custom.etax_submission_log(status, submitted_at);
```

### 9.6 Phor.Por.30 VAT Return Generation (conceptual SQL)

```sql
-- Sales side (Output VAT)
SELECT
  SUM(CASE WHEN vat_category='standard'  THEN net_amount ELSE 0 END) AS taxable_sales,
  SUM(CASE WHEN vat_category='zero'      THEN net_amount ELSE 0 END) AS zero_rated_sales,
  SUM(CASE WHEN vat_category='exempt'    THEN net_amount ELSE 0 END) AS exempt_sales,
  SUM(CASE WHEN vat_category='standard'  THEN vat_amount ELSE 0 END) AS output_vat
FROM custom.tax_invoice_lines
WHERE tax_point_date BETWEEN :periodStart AND :periodEnd
  AND document_status='posted';

-- Purchase side (Input VAT)
SELECT
  SUM(net_amount) AS purchases,
  SUM(vat_amount) AS input_vat_claimable
FROM custom.purchase_tax_invoice_lines
WHERE claim_month = :period          -- tracks the 6-month rule
  AND disallow_reason IS NULL;

-- Carry-forward from prior month
SELECT credit_carry_forward FROM custom.pp30_period WHERE period = :priorPeriod;
```

Export to XML per RD PP.30 e-filing spec — RD provides an XSD on efiling.rd.go.th.

### 9.7 Input VAT 6-Month Tracker

```sql
ALTER TABLE custom.purchase_tax_invoices
  ADD COLUMN tax_point_date date NOT NULL,
  ADD COLUMN claim_expiry_date date GENERATED ALWAYS AS (tax_point_date + interval '6 months') STORED,
  ADD COLUMN claimed_in_period text;   -- YYYYMM

-- Daily BullMQ job
SELECT id, vendor_name, tax_invoice_no, tax_point_date, claim_expiry_date
FROM custom.purchase_tax_invoices
WHERE claimed_in_period IS NULL
  AND claim_expiry_date <= (CURRENT_DATE + interval '30 days');
```

### 9.8 Multi-Branch VAT Invoicing

- `pos_sessions.branch_code` (char(5), default `'00000'`).
- `tax_invoices.issuing_branch_code` printed on the face.
- TIN field is shared org-wide; branch code disambiguates.
- Each branch can have independent sequential number: `{branch}-TX-YYMM-#####`.

### 9.9 No-VAT (Non-Registered) Merchant Mode

Config flag `org.vat_registered: boolean`:
- `false` → abbreviated-tax-invoice & full-tax-invoice paths disabled; only receipts (`RE-…`) printed.
- `false` → Output-VAT / Input-VAT accounts hidden from CoA presentation (but kept inactive).
- `false` → e-Tax Invoice module disabled.
- Transitioning from unregistered to registered: system must take a snapshot of inventory for VAT purpose (first-month input VAT on opening stock is not claimable retroactively — important seed).

### 9.10 Receipt QR Code

Not yet a mandatory field on paper tax invoices, but RD's **"Easy E-Receipt"** campaign encourages consumer-side QR scanning to auto-claim PIT deductions. Format commonly encoded:
```
TAX|TIN=0105551234567|BRN=00000|NO=TX-2604-00001|DATE=20260420|AMT=214.00|VAT=14.00|HASH=abcdef…
```
Or the URL to the e-Tax XML view on the ASP portal. Consumers scan with the RD mobile app.

### 9.11 Foreign-Currency Sales

If merchant accepts foreign currency:
- Tax invoice **must** show THB equivalent (dual-currency display).
- FX rate = **BoT mid-rate of the tax-point date** (or merchant's bank's rate, consistently). [lorenz-partners.com](https://lorenz-partners.com/foreign-currency-invoices-tha/)
- Once a source (BoT vs commercial bank) is chosen, merchant cannot switch mid-year.
- Data model:
  - `tax_invoices.currency` (ISO-4217)
  - `tax_invoices.fx_rate_thb` (numeric(18,8))
  - `tax_invoices.fx_source` ('BOT_MID','SCB_TTS',…)
  - `tax_invoices.amount_thb` (bigint cents — for VAT filing)
- BoT rate puller: cron daily 09:00 fetching [bot.or.th FX API](https://apiportal.bot.or.th) — OCA has `currency_rate_update_TH_BOT` we can reuse.

---

## 10. Odoo 18 / OCA Thai Localization

### 10.1 Native Odoo 18 Thai fiscal localization
Odoo 18 ships the **Thailand fiscal package** that activates when a company's country is set to Thailand:
- Standard Thai Chart of Accounts (simplified).
- Thai VAT taxes preset at 7% (purchase & sales, with exempt/zero variants).
- THB currency + BoT exchange-rate fetching (when currency_rate_update enabled).
- PromptPay QR on invoices. [odoo.com/documentation/17.0/thailand](https://www.odoo.com/documentation/17.0/applications/finance/fiscal_localizations/thailand.html)

### 10.2 OCA `l10n-thailand` modules (branch 18.0)

Source: `github.com/OCA/l10n-thailand/tree/18.0`. [OCA/l10n-thailand](https://github.com/OCA/l10n-thailand/blob/18.0/README.md)

| Module | Purpose | Status |
|--------|---------|--------|
| `currency_rate_update_TH_BOT` | Pulls BoT FX rates daily | 18.0 ✅ |
| `l10n_th_account_tax` | Sets up Thai VAT, WHT categories, deferred-VAT accounts | 18.0 ✅ |
| `l10n_th_account_tax_report` | Monthly Output/Input VAT reports (PDF/XLSX) matching §87 format | 18.0 ✅ |
| `l10n_th_account_wht_cert_form` | Generates 50-Tawi PDF from payment | 18.0 ✅ |
| `l10n_th_amount_to_text` | Spells THB amount in Thai words for invoice | 18.0 ✅ |
| `l10n_th_base_sequence` | Thai-style sequence (e.g., YYYY → พ.ศ. 2569) | 18.0 ✅ |
| `l10n_th_base_utils` | Thai fonts, Buddhist-calendar conversions | 18.0 ✅ |
| `l10n_th_mis_report` | MIS reports (P&L, BS in Thai format) | 18.0 ✅ |
| `l10n_th_partner` | Partner branch code, title Thai conventions | 18.0 ✅ |
| `l10n_th_tier_department` | Multi-dept approval tiers for WHT | 18.0 ✅ |

### 10.3 Known gaps in OCA / Odoo native (for 18.0)
- **e-Tax Invoice XML generation + signing** — not upstream. Earlier attempts exist in 15.0 branch; not ported to 18.0.
- **PromptPay on POS receipt** — Odoo sets it on invoices, but iPad/POS-side merging is thin.
- **PND.3 / PND.53 XML export** to match rd.go.th e-filing template — custom.
- **Advanced Phor.Por.30 XML** (vs simple PDF) — custom.
- **Real-time VAT report per branch** (multi-branch POS) — custom layer.

### 10.4 Commercial Thai Odoo modules (reference)
- **Ecosoft** — primary OCA maintainer, commercial support behind most `l10n_th_*` modules.
- **Mitphol** — wider Thai localization and customizations.
- **Infostack** — SME-focused Odoo implementations.
- **Exopen** — retail/POS oriented.

---

## 11. e-Tax Invoice Service Providers (ASP)

| Provider | Scope | API | Notes |
|---------|-------|-----|-------|
| **Leceipt (leceipt.com)** | Full XML + signing + RD submission | REST (JSON) — well documented, English-friendly | Widely used. [peakaccount.com/leceipt](https://www.peakaccount.com/peak-manual/api-integration/etax-integration/connecting-etax-invoice-via-leceipt) · [github.com/frevation/leceipt-api-example-code](https://github.com/frevation/leceipt-api-example-code) |
| **INET (inet.co.th)** | Full XML + CA + H2H | REST — requires TIN, branch, API Key, User Code, Access Key | Also acts as CA. [digit.inet.co.th](https://digit.inet.co.th/about.php?lang=en&sub=profile) |
| **eTax One (one.th) — Thai Wacoal** | Full XML + signing + e-Tax by Email | Web UI + REST | [etax.one.th](https://etax.one.th/) |
| **eTaxGo** | Full XML + ASP | REST (JSON) | [etaxgo.com](https://www.etaxgo.com/) |
| **Frank.co.th** | SME-oriented, subscription | REST | |
| **FlowAccount** | Accounting SaaS w/ e-Tax Invoice | REST (JSON); not RD-direct — uses partner ASP | |
| **PEAK Account** | Accounting SaaS integrated w/ Leceipt and INET | REST | |
| **Pagero / Sovos / EDICOM / Comarch** | International EDI players with Thai support | ebXML/REST | For multinationals |

Official list: [etax.rd.go.th — Service Provider catalog (Flipbook 09)](https://etax.rd.go.th/etax_staticpage/app/emag/flipbook_2567/pdf/09_Service-Provider.pdf)

### 11.1 Build-your-own vs ASP trade-off

| Dimension | Direct RD | ASP |
|-----------|-----------|-----|
| Upfront cost | High — CA cert (HSM preferred), ETDA enrolment, legal review | Low — just integrate |
| Per-doc cost | ~0 (RD free) | THB 0.5–3 / document (tiered) |
| Time to production | 3–6 months | 1–2 weeks |
| Ongoing compliance | You handle RD spec changes | ASP handles |
| Good for | Large volumes > 100K/mth, or enterprises wanting full control | SMEs, MVP phases |

**Recommendation for this project**: integrate **Leceipt first** (fewest friction, good docs, good Thai/English), then add **INET** as secondary, finally consider direct RD submission in scale-out phase — mirrors Phase D → E of the roadmap.

---

## 12. Existing Open-Source Projects

### 12.1 Thai-tax-specific

| Repo | Stars | Language | Purpose | License |
|------|-------|----------|---------|---------|
| [ETDA/etax-xades](https://github.com/ETDA/etax-xades) | 8 | Java | **Official** XAdES-BES signing sample for ETDA XML | Apache-2.0 (unverified — re-confirm) |
| [ETDA/XMLValidation](https://github.com/ETDA/XMLValidation) | (few) | Java | Official XSD validator with CrossIndustryInvoice 2.0 schemas | Apache-2.0 (unverified) |
| [ETDA/soda-etax](https://github.com/ETDA/soda-etax) | (few) | Java | Standalone utility for e-Tax by Email PDF/A-3 | Apache-2.0 (unverified) |
| [OCA/l10n-thailand](https://github.com/OCA/l10n-thailand) | ~60 | Python/Odoo | All Thai fiscal modules — VAT, WHT, sequence, MIS | AGPL-3.0 |
| [kittiu/thai_tax](https://github.com/kittiu/thai_tax) | ~30 | Python/ERPNext | Thai WHT + 50-Tawi for ERPNext (Ecosoft's Kitti U.) | MIT (unverified) |
| [pipech/frappe-thai-withholding-tax](https://github.com/pipech/frappe-thai-withholding-tax) | ~15 | Python/Frappe | WHT on Frappe | MIT (unverified) |
| [holsson95/thai-tax-calculator](https://github.com/holsson95/thai-tax-calculator) | (low) | TS/React | PIT bracket calculator | MIT (unverified) |
| [hspotlight/e-tax-invoice-and-e-receipt](https://github.com/hspotlight/e-tax-invoice-and-e-receipt) | (low) | Node.js | ETL of etax.rd.go.th merchant list into Algolia | MIT (unverified) |
| [frevation/leceipt-api-example-code](https://github.com/frevation/leceipt-api-example-code) | (low) | Node.js | Working example of Leceipt REST integration | MIT (unverified) |

### 12.2 PromptPay / Payment

| Repo | Stars | Purpose |
|------|-------|---------|
| [dtinth/promptpay-qr](https://github.com/dtinth/promptpay-qr) | ~600 | JS library for PromptPay payload — **de-facto standard** |
| [maythiwat/promptparse](https://github.com/maythiwat/promptparse) | ~100 | TS library for PromptPay + EMVCo read/write/validate |
| [ihiroshi27/promptpay-js](https://github.com/ihiroshi27/promptpay-js) | ~30 | Generate + parse PromptPay payload |
| [saladpuk/PromptPay](https://github.com/saladpuk/PromptPay) | ~200 | C# EMVCo read/write/validate |

### 12.3 General Reference

| Repo | Purpose |
|------|---------|
| [unnawut/awesome-thai-dev](https://github.com/unnawut/awesome-thai-dev) | Curated Thai-language dev resources |

---

## 13. Recommended Implementation Roadmap

### Phase A — MVP POS
- Issue **receipts** (`RE-…`) for non-VAT merchants.
- Issue **abbreviated tax invoices** (`ABB-…`) for VAT-registered retailers.
- Toggle: VAT 7% **inclusive vs exclusive** pricing.
- No customer TIN capture yet.
- CoA seeded with `1155/1156/2201/2202/2203`.
- **Gate**: PP.30 manual XLSX export produces correct Box 1–9.

### Phase B — Full Tax Invoice & VAT Filing (Weeks 7–10)
- Customer TIN capture at checkout (Mod-11 validated, branch code).
- Full tax invoice (`TX-…`) printing.
- Credit / Debit notes (§86/9–10).
- Monthly Input/Output VAT reports (PDF + XLSX).
- **Phor.Por.30 XML** auto-generated + downloadable.
- 6-month input-VAT expiry tracker with alert job.
- **Gate**: successfully file one month of PP.30 via rd.go.th with system output.

### Phase C — Withholding Tax (Weeks 10–12)
- AP WHT capture on vendor bills (auto-rate by category).
- **50-Tawi PDF** generator using `l10n_th_account_wht_cert_form` pattern.
- PND.3 / PND.53 XML export.
- AR-side: capture WHT on customer payments → debit `1157`.
- **Gate**: file one month of PND.3 + PND.53 successfully.

### Phase D — e-Tax Invoice via ASP (Month 4)
- Hexagonal adapter for **Leceipt REST API** (primary).
- Second adapter for **INET** (fallback / cost-sensitivity).
- Background BullMQ queue `etax-submission`.
- Support for Tax Invoice, Credit Note, Debit Note, Receipt.
- Store submission log + RD ack.
- **Gate**: 100% of month's tax invoices successfully acked by RD via ASP.

### Phase E — Direct RD Submission (Month 6+, only if volume justifies)
- Apply for ETDA enrolment + HSM-backed CA certificate.
- Java microservice using **[ETDA/etax-xades](https://github.com/ETDA/etax-xades)** for XAdES-BES signing (or port to Node with `xadesjs`/`node-forge`).
- Direct upload via etax.rd.go.th or H2H ebXML over MPLS.
- **Gate**: successfully submit 1,000 test documents in stage, zero rejections.

---

## 14. Risk / Compliance Watchouts

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Wrong buyer TIN** | Buyer loses input-VAT claim → merchant liability for refund or reputation | Mod-11 validation at POS, call **RD VAT TIN lookup API** (efiling.rd.go.th) before issuing if possible |
| **Missing "ใบกำกับภาษี" header** | Document is not a tax invoice; buyer cannot claim input | Hard-code header in template; never localise to another word |
| **Sequential-number gap** | RD audit flag — assume fraud | POS never skips numbers; voids become `VOID` entries; reserve next number on open, commit on post |
| **Back-dating invoices** | §85 violation — fine + possible criminal | Reject any invoice with date older than current tax month |
| **POS thermal paper fade** | Retention records unreadable within 5 yr | Always store e-PDF + XML beyond paper — make paper a *courtesy* |
| **Legal form confusion** ("ร้าน" vs "บริษัท") | Invalidated invoice | Validate against partner master + DBD cert on file |
| **Customer data on invoice under PDPA** | Name/TIN/address are personal data | Retention purpose = "tax compliance" justified; minimise; 5-yr purge job after retention window |
| **Short-paid VAT** | Surcharge 1.5%/mth + fine up to 200% | Reconcile PP.30 against GL automatically |
| **Issued tax invoice while not yet VAT-registered** | Up to THB 200K fine | Feature flag `vat_registered` gates tax-invoice module |
| **Input VAT > 6 months stale** | Permanently lost | Daily expiry tracker (see §9.7) |
| **e-Tax signed XML altered post-signing** | Invalid submission, RD rejection | Immutable blob storage + hash check before submit |
| **Foreign-currency invoice without THB** | Not recognised for VAT | Require dual-currency print; enforce BoT rate at tax-point |
| **FX rate source switched mid-year** | RD challenge | Lock `fx_source` per fiscal year in org settings |
| **Partial refund without credit note** | VAT under-remitted | Refund flow must always auto-issue CN |
| **Branch code mismatch** | Invoice invalidated for the issuing branch | Branch selector in POS cannot be edited mid-session |

---

## Cloneable Reference Repos

| Priority | Repo | Stars | Language | License | Why clone |
|---------|------|-------|----------|---------|-----------|
| **HIGH** | [OCA/l10n-thailand](https://github.com/OCA/l10n-thailand) (branch 18.0) | ~60 | Python | AGPL-3.0 | Canonical Thai fiscal package — VAT, WHT, 50-Tawi, MIS, BoT FX; study every module for field shapes & UX |
| **HIGH** | [ETDA/etax-xades](https://github.com/ETDA/etax-xades) | 8 | Java | Apache-2.0 (unverified) | Official ETDA XAdES-BES signer sample — reference for our Phase E direct-submission Java microservice or TS port |
| **HIGH** | [ETDA/XMLValidation](https://github.com/ETDA/XMLValidation) | (few) | Java | Apache-2.0 (unverified) | Official CrossIndustryInvoice 2.0 XSDs + validator — ship in CI to validate our generated XML |
| **HIGH** | [frevation/leceipt-api-example-code](https://github.com/frevation/leceipt-api-example-code) | (low) | Node.js | MIT (unverified) | Working Leceipt REST integration — template for our Phase D ASP adapter |
| **HIGH** | [dtinth/promptpay-qr](https://github.com/dtinth/promptpay-qr) | ~600 | JS | MIT | De-facto PromptPay QR generator — use directly on POS receipts |
| **MED** | [maythiwat/promptparse](https://github.com/maythiwat/promptparse) | ~100 | TS | MIT | Better-typed PromptPay + EMVCo library; cross-platform for RN & web |
| **MED** | [kittiu/thai_tax](https://github.com/kittiu/thai_tax) | ~30 | Python/ERPNext | MIT (unverified) | Good reference for WHT taxonomy + 50-Tawi PDF layout |
| **MED** | [pipech/frappe-thai-withholding-tax](https://github.com/pipech/frappe-thai-withholding-tax) | ~15 | Python/Frappe | MIT (unverified) | Alternative WHT implementation — different data-model to contrast |
| **MED** | [ETDA/soda-etax](https://github.com/ETDA/soda-etax) | (few) | Java | Apache-2.0 (unverified) | Reference for e-Tax by Email PDF/A-3 path |
| **LOW** | [holsson95/thai-tax-calculator](https://github.com/holsson95/thai-tax-calculator) | (low) | TS/React | MIT (unverified) | PIT bracket logic for payroll calc |
| **LOW** | [hspotlight/e-tax-invoice-and-e-receipt](https://github.com/hspotlight/e-tax-invoice-and-e-receipt) | (low) | Node.js | MIT (unverified) | ETL sample — lookup merchant RD status |
| **LOW** | [unnawut/awesome-thai-dev](https://github.com/unnawut/awesome-thai-dev) | ~1k | md | CC-BY-SA | Curated pointer list for future research |

---

## Sources

Primary statutes:
- [Revenue Code §85–86 (RD English)](https://www.rd.go.th/english/37741.html)
- [Revenue Code Chapter 4 VAT (RD English)](https://www.rd.go.th/english/37718.html)
- [Revenue Code §77–79 Tax Liability (RD English)](https://www.rd.go.th/english/37719.html)
- [Revenue Departmental Order Por.86/2542](https://www.rd.go.th/fileadmin/user_upload/kormor/eng/RDO_86.pdf)
- [Accounting Act B.E. 2543 (TFAC)](https://www.tfac.or.th/en/Article/Detail/77007)
- [Withholding Tax Certificate form (RD)](https://www.rd.go.th/fileadmin/download/english_form/frm_WTC.pdf)
- [FX rate rule (RD Notification)](https://www.rd.go.th/fileadmin/user_upload/kormor/eng/NOOF_Exchange_Rate.pdf)

Overviews and practitioner commentary:
- [Forvis Mazars — VAT in Thailand](https://www.forvismazars.com/th/en/insights/doing-business-in-thailand/tax/value-added-tax-vat-in-thailand)
- [Acclime — VAT in Thailand](https://thailand.acclime.com/guides/value-added-tax/)
- [Avalara — Thailand VAT Guide](https://www.avalara.com/us/en/vatlive/country-guides/asia/thailand.html)
- [PwC — Thailand corporate tax summary](https://taxsummaries.pwc.com/thailand/corporate/taxes-on-corporate-income)
- [Siam Legal — Section 86](https://library.siam-legal.com/thai-law/revenue-code-tax-invoice-debit-note-credit-note-section-86/)
- [Siam Legal — Section 81](https://library.siam-legal.com/thai-law/revenue-code-value-added-tax-exemption-section-81/)
- [FlowAccount — Abbreviated tax invoice](https://flowaccount.com/blog/abbreviated-tax-invoice-in-thailand/)
- [Benoit&Partners — Accounting standards](https://benoit-partners.com/accounting-standards-thailand/)
- [Benoit&Partners — Withholding tax](https://benoit-partners.com/thai-withholding-tax/)
- [VBA Partners — PND forms](https://vbapartners.com/thailand-tax-submission-pnd-forms-filing-secrets/)
- [VBA Partners — 50 Tawi](https://vbapartners.com/withholding-tax-certificate-thailand/)
- [HLB Thailand — e-Filing PND.1](https://www.hlbthai.com/e-filing-of-pnd1-thailand/)
- [Forvis Mazars — TFRS for NPAEs (revised)](https://www.forvismazars.com/th/en/insights/doing-business-in-thailand/accounting/revised-tfrs-for-npaes-effective)
- [Price Sanond — DBD e-Filing](https://www.pricesanond.com/knowledge/corporate-m-and-a/dbd-goes-paperless-for-financial-statement-filings.php)
- [Lorenz & Partners — Foreign-currency invoices](https://lorenz-partners.com/foreign-currency-invoices-tha/)
- [Thailand.go.th — VAT penalties](https://www.thailand.go.th/issue-focus-detail/007_057)
- [Gentlelaw IBL — VAT registration 2026](https://www.gentlelawibl.com/post/thailand-vat-registration-2026-threshold-por-por-01-steps-pp-30-filing-and-sme-compliance-roadma)
- [Gentlelaw IBL — PND.50 2026](https://www.gentlelawibl.com/post/thailand-pnd-50-filing-2026-corporate-income-tax-return-checklist-for-foreign-smes)

e-Tax:
- [Grant Thornton — Intro to e-Tax](https://www.grantthornton.co.th/insights/e-tax/)
- [Kasikorn Global Payment — e-Tax](https://www.kasikornglobalpayment.com/en/news/detail/what-is-e-tax)
- [PKF Thailand — Understanding e-Tax](https://pkfthailand.asia/understanding-e-tax-invoice-in-thailand/)
- [Sovos — Thailand e-Tax filing](https://sovos.com/blog/vat/thailand-e-tax-filing/)
- [EDICOM — Thailand e-invoicing](https://edicomgroup.com/blog/thailand-electronic-invoicing-model)
- [Comarch — e-Invoicing Thailand 2025](https://www.comarch.com/trade-and-services/data-management/e-invoicing/e-invoicing-in-thailand/)
- [SAP Community — Thailand e-Tax](https://community.sap.com/t5/technology-blog-posts-by-sap/thailand-e-tax-invoice-amp-e-receipt/ba-p/13543474)
- [ETDA GitLab — CrossIndustryInvoice XSD](https://schemas.teda.th/teda/teda-objects/common/e-tax-invoice-receipt/-/blob/master/ETDA/data/standard/TaxInvoice_CrossIndustryInvoice_2p0.xsd)
- [RD — ETAXSEARCH](https://etax.rd.go.th/ETAXSEARCH/about)
- [RD — Service Provider Catalog](https://etax.rd.go.th/etax_staticpage/app/emag/flipbook_2567/pdf/09_Service-Provider.pdf)

Odoo & OSS:
- [OCA/l10n-thailand](https://github.com/OCA/l10n-thailand/blob/18.0/README.md)
- [Odoo Thailand fiscal localisation (17.0 docs; 18 parallels)](https://www.odoo.com/documentation/17.0/applications/finance/fiscal_localizations/thailand.html)
- [ETDA/etax-xades](https://github.com/ETDA/etax-xades)
- [Leceipt API example](https://github.com/frevation/leceipt-api-example-code)
- [PEAK ↔ Leceipt integration guide](https://www.peakaccount.com/peak-manual/api-integration/etax-integration/connecting-etax-invoice-and-receipt-via-leceipt)
- [PEAK ↔ INET integration guide](https://www.peakaccount.com/peak-manual/api-integration/etax-integration/connecting-etax-invoice-and-receipt-via-inet)

TIN validation:
- [TaxDo — Thailand TIN](https://taxdo.com/resources/global-tax-id-validation-guide/thailand)
- [TIN-Check — Thailand](https://tin-check.com/en/thailand/)
- [OECD — Thailand TIN PDF](https://www.oecd.org/content/dam/oecd/en/topics/policy-issue-focus/aeoi/thailand-tin.pdf)
