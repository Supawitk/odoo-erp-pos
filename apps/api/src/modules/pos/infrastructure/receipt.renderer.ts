import { Injectable } from '@nestjs/common';
import QRCode from 'qrcode';
import { bahtTextFromSatang, generatePromptPayBill } from '@erp/shared';
import { OrganizationService } from '../../organization/organization.service';
import type { posOrders } from '@erp/db';

/**
 * Thai POS receipt renderer (HTML).
 *
 * Header selection per Revenue Code:
 *   RE  → "ใบเสร็จรับเงิน"                             (plain receipt)
 *   ABB → "ใบกำกับภาษีอย่างย่อ"                         (§86/6)
 *   TX  → "ใบกำกับภาษี"                                (§86/4)
 *   CN  → "ใบลดหนี้ / ใบกำกับภาษี"                       (§86/10)
 *
 * TX/ABB mandatory fields (§86/4 + §86/6):
 *   - Prominent Thai header
 *   - Seller legal name + TIN + branch + address
 *   - Document number + date
 *   - Line items (name, qty, unit price, amount)
 *   - Net + VAT + Total
 *   - For TX: buyer name, TIN, branch, address
 *
 * Design goals:
 *   - Zero external templating dep (raw string builder, HTML-escaped)
 *   - Works as email-body / PDF-input / thermal-print-HTML
 *   - 58mm / 80mm thermal stylesheet toggle via `narrow` flag
 */

type PosOrderRow = typeof posOrders.$inferSelect;

export interface ReceiptOptions {
  narrow?: boolean; // 58mm thermal = narrow, default 80mm
}

@Injectable()
export class ReceiptRenderer {
  constructor(private readonly org: OrganizationService) {}

  async render(order: PosOrderRow, opts: ReceiptOptions = {}): Promise<string> {
    const settings = await this.org.snapshot();
    const thaiMode = settings.countryMode === 'TH';
    return thaiMode
      ? this.renderThai(order, settings, opts)
      : this.renderGeneric(order, settings, opts);
  }

  private async renderThai(
    order: PosOrderRow,
    settings: Awaited<ReturnType<OrganizationService['snapshot']>>,
    opts: ReceiptOptions,
  ): Promise<string> {
    const header = this.headerFor(order.documentType as 'RE' | 'ABB' | 'TX' | 'CN' | 'DN');
    const lines = order.orderLines as Array<{
      name: string;
      qty: number;
      unitPriceCents: number;
      grossCents?: number;
      modifiers?: Array<{ groupName: string; name: string; priceDeltaCents: number }>;
    }>;

    const promptpayQr = await this.buildQrDataUrlIfApplicable(order, settings);
    const amountText = bahtTextFromSatang(Math.abs(order.totalCents));

    const items = lines
      .map(
        (l) => `
          <tr>
            <td>${escapeHtml(l.name)}${modifiersHtmlTh(l.modifiers)}</td>
            <td class="r">${l.qty}</td>
            <td class="r">${formatBaht(l.unitPriceCents)}</td>
            <td class="r">${formatBaht(l.grossCents ?? l.qty * l.unitPriceCents)}</td>
          </tr>`,
      )
      .join('');

    const buyerBlock = order.buyerName
      ? `
        <div class="buyer">
          <div><b>ผู้ซื้อ:</b> ${escapeHtml(order.buyerName)}</div>
          ${order.buyerTin ? `<div>TIN: ${order.buyerTin} สาขา: ${order.buyerBranch}</div>` : ''}
          ${order.buyerAddress ? `<div>${escapeHtml(order.buyerAddress)}</div>` : ''}
        </div>`
      : '';

    const cnNotice =
      order.documentType === 'CN'
        ? `<div class="cn-notice">ใบลดหนี้อ้างอิงรายการขายเดิม — ${escapeHtml(
            (order.paymentDetails as any)?.refundReason ?? 'ไม่ระบุเหตุผล',
          )}</div>`
        : order.documentType === 'DN'
        ? `<div class="cn-notice">ใบเพิ่มหนี้อ้างอิงรายการขายเดิม — ${escapeHtml(
            (order.paymentDetails as any)?.dnReason ?? 'ไม่ระบุเหตุผล',
          )}</div>`
        : '';

    const width = opts.narrow ? '58mm' : '80mm';

    return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8"/>
<title>${header} ${order.documentNumber ?? ''}</title>
<style>
  @page { size: ${width} auto; margin: 2mm; }
  body { font-family: "Sarabun", "Noto Sans Thai", sans-serif; font-size: 10pt; color: #000; }
  h1 { text-align: center; font-size: 11pt; margin: 2mm 0; }
  .seller { text-align: center; margin-bottom: 3mm; }
  .seller .name { font-weight: bold; }
  .meta { display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 2mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 1mm 0; border-bottom: 1px dashed #666; font-size: 9pt; }
  th { text-align: left; }
  .r { text-align: right; }
  tfoot td { border-top: 2px solid #000; font-weight: bold; }
  .amount-text { margin-top: 3mm; font-style: italic; text-align: center; font-size: 9pt; }
  .buyer { margin-top: 3mm; padding: 2mm; border: 1px solid #888; font-size: 9pt; }
  .cn-notice { margin: 3mm 0; padding: 2mm; background: #fde; text-align: center; }
  .qr { text-align: center; margin-top: 4mm; }
  .qr img { width: 45mm; height: 45mm; }
  .footer { text-align: center; margin-top: 4mm; font-size: 8pt; color: #555; }
</style>
</head>
<body>
  <h1>${header}</h1>
  <div class="seller">
    <div class="name">${escapeHtml(settings.sellerName)}</div>
    <div>${escapeHtml(settings.sellerAddress)}</div>
    <div>TIN: ${settings.sellerTin} ${settings.sellerBranch === '00000' ? '(สำนักงานใหญ่)' : `(สาขา ${settings.sellerBranch})`}</div>
  </div>
  <div class="meta">
    <span>เลขที่: ${order.documentNumber ?? '-'}</span>
    <span>${order.createdAt ? new Date(order.createdAt).toLocaleString('th-TH') : ''}</span>
  </div>
  ${restaurantBlockTh(order)}
  ${buyerBlock}
  ${cnNotice}
  <table>
    <thead>
      <tr><th>รายการ</th><th class="r">จน.</th><th class="r">ราคา</th><th class="r">รวม</th></tr>
    </thead>
    <tbody>${items}</tbody>
    <tfoot>
      <tr><td colspan="3">มูลค่าสินค้า (ก่อน VAT)</td><td class="r">${formatBaht((order.vatBreakdown as any)?.taxableNetCents ?? order.subtotalCents)}</td></tr>
      <tr><td colspan="3">ภาษีมูลค่าเพิ่ม ${formatRatePct(settings.vatRate)}%</td><td class="r">${formatBaht(order.taxCents)}</td></tr>
      ${(order.vatBreakdown as any)?.zeroRatedNetCents ? `<tr><td colspan="3">ศูนย์เปอร์เซ็นต์</td><td class="r">${formatBaht((order.vatBreakdown as any).zeroRatedNetCents)}</td></tr>` : ''}
      ${(order.vatBreakdown as any)?.exemptNetCents ? `<tr><td colspan="3">ยกเว้นภาษี</td><td class="r">${formatBaht((order.vatBreakdown as any).exemptNetCents)}</td></tr>` : ''}
      <tr><td colspan="3">รวมทั้งสิ้น</td><td class="r">${formatBaht(order.totalCents)}</td></tr>
      ${order.tipCents && order.tipCents > 0 ? `<tr><td colspan="3">ทิป (Tip)</td><td class="r">${formatBaht(order.tipCents)}</td></tr><tr><td colspan="3"><strong>รวมที่ต้องชำระ</strong></td><td class="r"><strong>${formatBaht(order.totalCents + order.tipCents)}</strong></td></tr>` : ''}
    </tfoot>
  </table>
  <div class="amount-text">(${escapeHtml(amountText)})</div>
  <div>ชำระโดย: ${paymentLabel(order.paymentMethod)}</div>
  ${promptpayQr ? `<div class="qr"><img src="${promptpayQr.dataUri}" alt="PromptPay"/><div>สแกนจ่าย ${promptpayQr.amountBaht.toFixed(2)} ฿</div></div>` : ''}
  <div class="footer">ขอบคุณที่ใช้บริการ / Thank you</div>
</body>
</html>`;
  }

  /**
   * Generic (non-Thai) receipt. Plain "RECEIPT" header, Intl-formatted money,
   * no TIN block, no Thai-words, no VAT accounting detail beyond a single tax
   * line (computed by the pricing engine using the org's configured rate).
   */
  private async renderGeneric(
    order: PosOrderRow,
    settings: Awaited<ReturnType<OrganizationService['snapshot']>>,
    opts: ReceiptOptions,
  ): Promise<string> {
    const lines = order.orderLines as Array<{
      name: string;
      qty: number;
      unitPriceCents: number;
      grossCents?: number;
      modifiers?: Array<{ groupName: string; name: string; priceDeltaCents: number }>;
    }>;
    const width = opts.narrow ? '58mm' : '80mm';
    const money = (cents: number) =>
      new Intl.NumberFormat(settings.locale, {
        style: 'currency',
        currency: order.currency || settings.currency,
      }).format(cents / 100);

    const items = lines
      .map(
        (l) => `
          <tr>
            <td>${escapeHtml(l.name)}${modifiersHtmlEn(l.modifiers, money)}</td>
            <td class="r">${l.qty}</td>
            <td class="r">${money(l.unitPriceCents)}</td>
            <td class="r">${money(l.grossCents ?? l.qty * l.unitPriceCents)}</td>
          </tr>`,
      )
      .join('');

    const buyerBlock = order.buyerName
      ? `<div class="buyer"><b>Customer:</b> ${escapeHtml(order.buyerName)}${
          order.buyerAddress ? `<br/>${escapeHtml(order.buyerAddress)}` : ''
        }</div>`
      : '';

    const refundNotice =
      order.documentType === 'CN'
        ? `<div class="cn-notice">REFUND — ${escapeHtml(
            (order.paymentDetails as any)?.refundReason ?? 'no reason',
          )}</div>`
        : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Receipt ${order.documentNumber ?? ''}</title>
<style>
  @page { size: ${width} auto; margin: 2mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 10pt; color: #000; }
  h1 { text-align: center; font-size: 13pt; margin: 2mm 0; letter-spacing: 2px; }
  .seller { text-align: center; margin-bottom: 3mm; }
  .seller .name { font-weight: bold; }
  .meta { display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 2mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 1mm 0; border-bottom: 1px dashed #666; font-size: 9pt; }
  th { text-align: left; }
  .r { text-align: right; }
  tfoot td { border-top: 2px solid #000; font-weight: bold; }
  .buyer { margin-top: 3mm; padding: 2mm; border: 1px solid #888; font-size: 9pt; }
  .cn-notice { margin: 3mm 0; padding: 2mm; background: #fde; text-align: center; }
  .footer { text-align: center; margin-top: 4mm; font-size: 8pt; color: #555; }
</style>
</head>
<body>
  <h1>${order.documentType === 'CN' ? 'CREDIT NOTE' : order.documentType === 'DN' ? 'DEBIT NOTE' : 'RECEIPT'}</h1>
  <div class="seller">
    <div class="name">${escapeHtml(settings.sellerName || 'Merchant')}</div>
    ${settings.sellerAddress ? `<div>${escapeHtml(settings.sellerAddress)}</div>` : ''}
  </div>
  <div class="meta">
    <span>No: ${order.documentNumber ?? '-'}</span>
    <span>${order.createdAt ? new Date(order.createdAt).toLocaleString(settings.locale) : ''}</span>
  </div>
  ${restaurantBlockEn(order)}
  ${buyerBlock}
  ${refundNotice}
  <table>
    <thead>
      <tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr>
    </thead>
    <tbody>${items}</tbody>
    <tfoot>
      <tr><td colspan="3">Subtotal</td><td class="r">${money(order.subtotalCents)}</td></tr>
      ${order.taxCents ? `<tr><td colspan="3">Tax</td><td class="r">${money(order.taxCents)}</td></tr>` : ''}
      <tr><td colspan="3">Total</td><td class="r">${money(order.totalCents)}</td></tr>
      ${order.tipCents && order.tipCents > 0 ? `<tr><td colspan="3">Tip</td><td class="r">${money(order.tipCents)}</td></tr><tr><td colspan="3"><strong>Total due</strong></td><td class="r"><strong>${money(order.totalCents + order.tipCents)}</strong></td></tr>` : ''}
    </tfoot>
  </table>
  <div>Paid by: ${genericPaymentLabel(order.paymentMethod)}</div>
  <div class="footer">Thank you for your business</div>
</body>
</html>`;
  }

  private headerFor(type: 'RE' | 'ABB' | 'TX' | 'CN' | 'DN'): string {
    switch (type) {
      case 'TX':
        return 'ใบกำกับภาษี';
      case 'ABB':
        return 'ใบกำกับภาษีอย่างย่อ';
      case 'CN':
        return 'ใบลดหนี้';
      case 'DN':
        return 'ใบเพิ่มหนี้';
      default:
        return 'ใบเสร็จรับเงิน';
    }
  }

  /**
   * Rasterise the PromptPay payload into a real scannable PNG data-URL.
   * Uses `qrcode` (pure JS) with error correction level H so partial occlusion
   * (logo, folds, thermal paper fade) still resolves — Thai QR Payment spec
   * recommends M+; we go higher to survive 58mm thermal printing.
   */
  private async buildQrDataUrlIfApplicable(
    order: PosOrderRow,
    settings: Awaited<ReturnType<OrganizationService['snapshot']>>,
  ): Promise<{ dataUri: string; amountBaht: number; payload: string } | null> {
    if (order.paymentMethod !== 'promptpay' || !order.promptpayRef) return null;
    if (!settings.promptpayBillerId) return null;

    const amountBaht = order.totalCents / 100;
    const payload = generatePromptPayBill({
      billerId: settings.promptpayBillerId,
      amountBaht,
      ref1: order.promptpayRef,
    });

    const dataUri = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 256,
      color: { dark: '#000000', light: '#FFFFFF' },
    });
    return { dataUri, amountBaht, payload };
  }
}

function formatBaht(satang: number): string {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

/**
 * Format a tax rate (0..1) as a clean percentage string. Hides trailing
 * zeros — 0.07 → "7", 0.075 → "7.5". Float-precision-safe via toFixed(4).
 */
function formatRatePct(rate: number): string {
  const pct = Number((rate * 100).toFixed(4));
  return Number.isInteger(pct) ? String(pct) : String(pct);
}

function restaurantBlockTh(order: any): string {
  if (!order.orderType) return '';
  const labels: Record<string, string> = {
    dine_in: 'ทานที่ร้าน',
    takeout: 'กลับบ้าน',
    delivery: 'จัดส่ง',
  };
  const label = labels[order.orderType] ?? order.orderType;
  const tablePart = order.tableNumber ? ` · โต๊ะ ${escapeHtml(order.tableNumber)}` : '';
  return `<div class="meta"><strong>ประเภท:</strong> ${escapeHtml(label)}${tablePart}</div>`;
}

function restaurantBlockEn(order: any): string {
  if (!order.orderType) return '';
  const labels: Record<string, string> = {
    dine_in: 'Dine-in',
    takeout: 'Takeout',
    delivery: 'Delivery',
  };
  const label = labels[order.orderType] ?? order.orderType;
  const tablePart = order.tableNumber ? ` · Table ${escapeHtml(order.tableNumber)}` : '';
  return `<div class="meta"><strong>${escapeHtml(label)}</strong>${tablePart}</div>`;
}

/**
 * Render an order-line's modifiers underneath the line name. Free modifiers
 * (delta=0) are shown name-only; paid/discounted modifiers show the signed
 * delta in parens. Indented with leading "•" so it's visually distinct from
 * the parent line.
 */
function modifiersHtmlTh(
  mods: Array<{ groupName: string; name: string; priceDeltaCents: number }> | undefined,
): string {
  if (!mods || mods.length === 0) return '';
  const items = mods
    .map((m) => {
      const label = escapeHtml(m.name);
      if (m.priceDeltaCents === 0) return `<div class="mod">• ${label}</div>`;
      const sign = m.priceDeltaCents > 0 ? '+' : '−';
      return `<div class="mod">• ${label} (${sign}${formatBaht(Math.abs(m.priceDeltaCents))})</div>`;
    })
    .join('');
  return `<div class="mods">${items}</div><style>.mods{margin-left:8pt}.mod{font-size:8.5pt;color:#444}</style>`;
}

function modifiersHtmlEn(
  mods: Array<{ groupName: string; name: string; priceDeltaCents: number }> | undefined,
  money: (cents: number) => string,
): string {
  if (!mods || mods.length === 0) return '';
  const items = mods
    .map((m) => {
      const label = escapeHtml(m.name);
      if (m.priceDeltaCents === 0) return `<div class="mod">• ${label}</div>`;
      const sign = m.priceDeltaCents > 0 ? '+' : '−';
      return `<div class="mod">• ${label} (${sign}${money(Math.abs(m.priceDeltaCents))})</div>`;
    })
    .join('');
  return `<div class="mods">${items}</div><style>.mods{margin-left:8pt}.mod{font-size:8.5pt;color:#444}</style>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paymentLabel(method: string): string {
  switch (method) {
    case 'cash':
      return 'เงินสด';
    case 'card':
      return 'บัตรเครดิต/เดบิต';
    case 'promptpay':
      return 'PromptPay';
    case 'split':
      return 'ชำระแบบผสม';
    default:
      return method;
  }
}

function genericPaymentLabel(method: string): string {
  switch (method) {
    case 'cash':
      return 'Cash';
    case 'card':
      return 'Card';
    case 'split':
      return 'Split';
    default:
      return method;
  }
}
