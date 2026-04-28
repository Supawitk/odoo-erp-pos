/**
 * ESC/POS thermal printer wrapper.
 *
 * Uses `react-native-thermal-receipt-printer@1.1.5` which speaks Epson ESC/POS
 * over Bluetooth or LAN. This module:
 *   1. Scans + pairs + prints — hides SDK surface area from screens.
 *   2. Produces a Thai-language 58mm receipt matching the server-side HTML
 *      renderer (same document-type switch, same header strings).
 *   3. MOCK mode logs the formatted payload when no printer is paired (during
 *      dev in simulator).
 *
 * Device test pending: requires a paired physical 58mm/80mm thermal printer
 * (e.g. Epson TM-M30 / Star TSP143). The code path compiles + types cleanly;
 * runtime requires real hardware + BLE pairing on an iPad.
 */
import { BLEPrinter } from 'react-native-thermal-receipt-printer';

// Inline minimal baht-text for the mobile app — keeps it zero-workspace-dep.
// A follow-up pass can link @erp/shared through Metro's resolver.
function bahtTextFromSatang(satang: number): string {
  const whole = Math.floor(Math.abs(satang) / 100);
  const frac = Math.abs(satang) % 100;
  const sign = satang < 0 ? '-' : '';
  return frac === 0
    ? `${sign}${whole.toLocaleString('th-TH')} บาทถ้วน`
    : `${sign}${whole.toLocaleString('th-TH')} บาท ${frac} สตางค์`;
}

type ReceiptData = {
  documentType: 'RE' | 'ABB' | 'TX' | 'CN';
  documentNumber: string;
  createdAt: string;
  totalCents: number;
  taxCents: number;
  subtotalCents: number;
  paymentMethod: string;
  orderLines: Array<{ name: string; qty: number; unitPriceCents: number; grossCents?: number }>;
  buyer?: { name?: string; tin?: string; branch?: string; address?: string } | null;
  currency: string;
  promptpayQr?: string | null;
};

const MOCK = true; // Set false once a real printer is paired

function headerThai(type: 'RE' | 'ABB' | 'TX' | 'CN'): string {
  switch (type) {
    case 'TX':
      return 'ใบกำกับภาษี';
    case 'ABB':
      return 'ใบกำกับภาษีอย่างย่อ';
    case 'CN':
      return 'ใบลดหนี้';
    default:
      return 'ใบเสร็จรับเงิน';
  }
}

function formatPlain(order: ReceiptData): string {
  const lines: string[] = [];
  lines.push(centerPad(headerThai(order.documentType), 32));
  lines.push('-'.repeat(32));
  lines.push(`เลขที่: ${order.documentNumber}`);
  lines.push(new Date(order.createdAt).toLocaleString('th-TH'));
  if (order.buyer?.name) {
    lines.push(`ผู้ซื้อ: ${order.buyer.name}`);
    if (order.buyer.tin) lines.push(`TIN: ${order.buyer.tin}`);
  }
  lines.push('-'.repeat(32));
  for (const l of order.orderLines) {
    lines.push(`${l.qty} x ${l.name}`);
    lines.push(
      rightPad(
        ` @${(l.unitPriceCents / 100).toFixed(2)}`,
        `= ${((l.grossCents ?? l.qty * l.unitPriceCents) / 100).toFixed(2)}`,
        32,
      ),
    );
  }
  lines.push('-'.repeat(32));
  lines.push(rightPad('Subtotal', (order.subtotalCents / 100).toFixed(2), 32));
  lines.push(rightPad('VAT 7%', (order.taxCents / 100).toFixed(2), 32));
  lines.push(rightPad('TOTAL', (order.totalCents / 100).toFixed(2), 32));
  lines.push(`ชำระโดย: ${order.paymentMethod}`);
  lines.push('-'.repeat(32));
  lines.push(`(${bahtTextFromSatang(Math.abs(order.totalCents))})`);
  if (order.promptpayQr) {
    lines.push('');
    lines.push('PROMPTPAY QR (payload below):');
    lines.push(order.promptpayQr);
  }
  lines.push('');
  lines.push(centerPad('ขอบคุณที่ใช้บริการ', 32));
  lines.push('');
  return lines.join('\n');
}

function rightPad(left: string, right: string, width: number): string {
  const pad = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(pad) + right;
}

function centerPad(s: string, width: number): string {
  if (s.length >= width) return s;
  const total = width - s.length;
  const left = Math.floor(total / 2);
  return ' '.repeat(left) + s;
}

// ─── Public API ───────────────────────────────────────────────────────────

export async function scanPrinters() {
  if (MOCK) {
    return [{ device_name: 'MockPrinter-58mm', inner_mac_address: '00:00:00:00:00:00' }];
  }
  await (BLEPrinter as any).init();
  return (BLEPrinter as any).getDeviceList();
}

export async function pair(address: string) {
  if (MOCK) {
    // eslint-disable-next-line no-console
    console.log('[thermal] mock pair with', address);
    return;
  }
  await (BLEPrinter as any).connectPrinter(address);
}

export async function printReceipt(order: ReceiptData) {
  const payload = formatPlain(order);
  if (MOCK) {
    // eslint-disable-next-line no-console
    console.log('[thermal] mock print payload:\n' + payload);
    return { bytes: payload.length, mock: true };
  }
  await (BLEPrinter as any).printText(payload);
  return { bytes: payload.length, mock: false };
}
