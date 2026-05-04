/**
 * Thai SME chart of accounts (TFRS for NPAEs).
 *
 * Codes follow the conventional 4-digit Thai SME convention:
 *   1xxx  Assets
 *   2xxx  Liabilities
 *   3xxx  Equity
 *   4xxx  Revenue
 *   5xxx  Cost of goods / services
 *   6xxx  Operating expenses
 *   7xxx  Other income
 *   8xxx  Other expenses (incl. interest, FX)
 *   9xxx  Income tax
 *
 * The accounts the rest of the system explicitly references (POS auto-post,
 * VAT report, WHT) are flagged in the trailing comment for findability.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalBalance = 'debit' | 'credit';

export interface ChartAccountSeed {
  code: string;
  nameTh: string;
  nameEn: string;
  type: AccountType;
  parentCode?: string;
  normalBalance: NormalBalance;
  /**
   * True for accounts that should appear as cash in dropdowns and roll up
   * into the Cash Flow Statement's cash + cash equivalents line. Optional;
   * defaults to false. Only set on initial INSERT — the seeder preserves
   * the user's existing flag on conflict so toggles in the UI stick.
   */
  isCashAccount?: boolean;
}

export const THAI_SME_CHART: ChartAccountSeed[] = [
  // ────────── 1xxx Assets ──────────
  { code: '1100', nameTh: 'เงินสดและรายการเทียบเท่าเงินสด', nameEn: 'Cash and cash equivalents', type: 'asset', normalBalance: 'debit' },
  { code: '1110', nameTh: 'เงินสดในมือ', nameEn: 'Cash on hand', type: 'asset', parentCode: '1100', normalBalance: 'debit', isCashAccount: true }, // POS cash sale Dr
  { code: '1120', nameTh: 'เงินฝากธนาคาร — กระแสรายวัน', nameEn: 'Bank — checking', type: 'asset', parentCode: '1100', normalBalance: 'debit', isCashAccount: true }, // Card settlement Dr
  { code: '1130', nameTh: 'เงินฝากธนาคาร — ออมทรัพย์', nameEn: 'Bank — savings', type: 'asset', parentCode: '1100', normalBalance: 'debit', isCashAccount: true },
  { code: '1135', nameTh: 'ค่าธรรมเนียมบัตรค้างรับ', nameEn: 'Card settlement in transit', type: 'asset', parentCode: '1100', normalBalance: 'debit' },

  { code: '1140', nameTh: 'ลูกหนี้การค้าและลูกหนี้อื่น', nameEn: 'Accounts receivable', type: 'asset', normalBalance: 'debit' },
  { code: '1141', nameTh: 'ลูกหนี้การค้า', nameEn: 'AR — trade', type: 'asset', parentCode: '1140', normalBalance: 'debit' },
  { code: '1142', nameTh: 'ลูกหนี้อื่น', nameEn: 'AR — other', type: 'asset', parentCode: '1140', normalBalance: 'debit' },

  { code: '1150', nameTh: 'ภาษีและสิทธิประโยชน์ค้างรับ', nameEn: 'Tax assets', type: 'asset', normalBalance: 'debit' },
  { code: '1155', nameTh: 'ภาษีซื้อ', nameEn: 'Input VAT', type: 'asset', parentCode: '1150', normalBalance: 'debit' }, // Vendor bill Dr
  { code: '1156', nameTh: 'ภาษีซื้อรอเรียกคืน', nameEn: 'Deferred Input VAT', type: 'asset', parentCode: '1150', normalBalance: 'debit' }, // §82/3 timing diff
  { code: '1157', nameTh: 'ภาษีหัก ณ ที่จ่ายค้างรับ', nameEn: 'WHT receivable', type: 'asset', parentCode: '1150', normalBalance: 'debit' }, // Customer pays net

  { code: '1160', nameTh: 'สินค้าคงเหลือ', nameEn: 'Inventory', type: 'asset', normalBalance: 'debit' },
  { code: '1161', nameTh: 'สินค้าสำเร็จรูป', nameEn: 'Finished goods', type: 'asset', parentCode: '1160', normalBalance: 'debit' }, // POS sale Cr (COGS)
  { code: '1162', nameTh: 'สินค้าระหว่างผลิต', nameEn: 'Work in progress', type: 'asset', parentCode: '1160', normalBalance: 'debit' },
  { code: '1163', nameTh: 'วัตถุดิบ', nameEn: 'Raw materials', type: 'asset', parentCode: '1160', normalBalance: 'debit' },

  { code: '1170', nameTh: 'ค่าใช้จ่ายล่วงหน้า', nameEn: 'Prepaid expenses', type: 'asset', normalBalance: 'debit' },
  { code: '1180', nameTh: 'สินทรัพย์หมุนเวียนอื่น', nameEn: 'Other current assets', type: 'asset', normalBalance: 'debit' },

  { code: '1500', nameTh: 'ที่ดิน อาคาร และอุปกรณ์', nameEn: 'Property, plant & equipment', type: 'asset', normalBalance: 'debit' },
  { code: '1510', nameTh: 'ที่ดิน', nameEn: 'Land', type: 'asset', parentCode: '1500', normalBalance: 'debit' },
  { code: '1520', nameTh: 'อาคารและสิ่งปลูกสร้าง', nameEn: 'Buildings', type: 'asset', parentCode: '1500', normalBalance: 'debit' },
  { code: '1530', nameTh: 'เครื่องจักรและอุปกรณ์', nameEn: 'Equipment', type: 'asset', parentCode: '1500', normalBalance: 'debit' },
  { code: '1540', nameTh: 'ยานพาหนะ', nameEn: 'Vehicles', type: 'asset', parentCode: '1500', normalBalance: 'debit' },
  { code: '1590', nameTh: 'ค่าเสื่อมราคาสะสม', nameEn: 'Accumulated depreciation', type: 'asset', parentCode: '1500', normalBalance: 'credit' }, // Contra-asset

  // ────────── 2xxx Liabilities ──────────
  { code: '2100', nameTh: 'เจ้าหนี้การค้าและเจ้าหนี้อื่น', nameEn: 'Accounts payable', type: 'liability', normalBalance: 'credit' },
  { code: '2110', nameTh: 'เจ้าหนี้การค้า', nameEn: 'AP — trade', type: 'liability', parentCode: '2100', normalBalance: 'credit' }, // Vendor bill Cr
  { code: '2120', nameTh: 'เจ้าหนี้อื่น', nameEn: 'AP — other', type: 'liability', parentCode: '2100', normalBalance: 'credit' },

  { code: '2200', nameTh: 'ภาษีและประกันสังคมค้างจ่าย', nameEn: 'Tax & SSO payable', type: 'liability', normalBalance: 'credit' },
  { code: '2201', nameTh: 'ภาษีขาย', nameEn: 'Output VAT', type: 'liability', parentCode: '2200', normalBalance: 'credit' }, // POS sale Cr
  { code: '2202', nameTh: 'ภาษีขายรอนำส่ง', nameEn: 'Deferred Output VAT', type: 'liability', parentCode: '2200', normalBalance: 'credit' },
  { code: '2203', nameTh: 'ภาษีหัก ณ ที่จ่ายค้างจ่าย', nameEn: 'WHT payable', type: 'liability', parentCode: '2200', normalBalance: 'credit' }, // 50-Tawi
  { code: '2210', nameTh: 'ประกันสังคมค้างจ่าย', nameEn: 'SSO payable', type: 'liability', parentCode: '2200', normalBalance: 'credit' },
  { code: '2220', nameTh: 'ภาษีเงินได้ค้างจ่าย', nameEn: 'Income tax payable', type: 'liability', parentCode: '2200', normalBalance: 'credit' },

  { code: '2300', nameTh: 'ค่าใช้จ่ายค้างจ่าย', nameEn: 'Accrued expenses', type: 'liability', normalBalance: 'credit' },
  { code: '2400', nameTh: 'รายได้รับล่วงหน้า / มัดจำลูกค้า', nameEn: 'Customer deposits / Unearned revenue', type: 'liability', normalBalance: 'credit' },
  { code: '2500', nameTh: 'เงินกู้ยืมระยะยาว', nameEn: 'Long-term loans', type: 'liability', normalBalance: 'credit' },

  // ────────── 3xxx Equity ──────────
  { code: '3110', nameTh: 'ทุนจดทะเบียน', nameEn: 'Common stock', type: 'equity', normalBalance: 'credit' },
  { code: '3210', nameTh: 'กำไรสะสม', nameEn: 'Retained earnings', type: 'equity', normalBalance: 'credit' },
  { code: '3300', nameTh: 'กำไร (ขาดทุน) งวดปัจจุบัน', nameEn: 'Current period income', type: 'equity', normalBalance: 'credit' },

  // ────────── 4xxx Revenue ──────────
  { code: '4110', nameTh: 'รายได้จากการขาย', nameEn: 'Sales revenue — products', type: 'revenue', normalBalance: 'credit' }, // POS sale Cr
  { code: '4120', nameTh: 'รายได้จากการบริการ', nameEn: 'Service revenue', type: 'revenue', normalBalance: 'credit' },
  { code: '4130', nameTh: 'ส่วนลดจ่าย', nameEn: 'Sales discounts', type: 'revenue', normalBalance: 'debit' }, // contra
  { code: '4140', nameTh: 'รับคืนสินค้า', nameEn: 'Sales returns', type: 'revenue', normalBalance: 'debit' }, // CN refund Dr (contra)
  { code: '4150', nameTh: 'รายได้อื่นจากการดำเนินงาน', nameEn: 'Other operating income', type: 'revenue', normalBalance: 'credit' },

  // ────────── 5xxx COGS ──────────
  { code: '5100', nameTh: 'ต้นทุนสินค้าที่ขาย', nameEn: 'COGS — products', type: 'expense', normalBalance: 'debit' }, // Inventory deduction
  { code: '5200', nameTh: 'ต้นทุนการให้บริการ', nameEn: 'COGS — services', type: 'expense', normalBalance: 'debit' },

  // ────────── 6xxx Operating expenses ──────────
  { code: '6110', nameTh: 'เงินเดือนและค่าจ้าง', nameEn: 'Salaries & wages', type: 'expense', normalBalance: 'debit' },
  { code: '6120', nameTh: 'ประกันสังคม (ส่วนนายจ้าง)', nameEn: 'SSO contributions', type: 'expense', normalBalance: 'debit' },
  { code: '6130', nameTh: 'ค่าเช่า', nameEn: 'Rent', type: 'expense', normalBalance: 'debit' },
  { code: '6140', nameTh: 'ค่าสาธารณูปโภค', nameEn: 'Utilities', type: 'expense', normalBalance: 'debit' },
  { code: '6150', nameTh: 'ค่าโฆษณาและการตลาด', nameEn: 'Marketing', type: 'expense', normalBalance: 'debit' },
  { code: '6160', nameTh: 'ค่าวัสดุสำนักงาน', nameEn: 'Office supplies', type: 'expense', normalBalance: 'debit' },
  { code: '6170', nameTh: 'ค่าธรรมเนียมธนาคารและบัตรเครดิต', nameEn: 'Bank & card fees', type: 'expense', normalBalance: 'debit' }, // Card settlement
  { code: '6180', nameTh: 'ค่าธรรมเนียมวิชาชีพ', nameEn: 'Professional fees', type: 'expense', normalBalance: 'debit' },
  { code: '6190', nameTh: 'ค่าเสื่อมราคา', nameEn: 'Depreciation', type: 'expense', normalBalance: 'debit' },
  { code: '6200', nameTh: 'ค่าใช้จ่ายดำเนินงานอื่น', nameEn: 'Other operating expenses', type: 'expense', normalBalance: 'debit' },

  // ────────── 7xxx-9xxx Other ──────────
  { code: '7110', nameTh: 'ดอกเบี้ยรับ', nameEn: 'Interest income', type: 'revenue', normalBalance: 'credit' },
  { code: '7120', nameTh: 'กำไรจากการจำหน่ายสินทรัพย์', nameEn: 'Gain on disposal of assets', type: 'revenue', normalBalance: 'credit' }, // Fixed-asset disposal Cr
  { code: '8110', nameTh: 'ดอกเบี้ยจ่าย', nameEn: 'Interest expense', type: 'expense', normalBalance: 'debit' },
  { code: '8120', nameTh: 'ขาดทุนจากการจำหน่ายสินทรัพย์', nameEn: 'Loss on disposal of assets', type: 'expense', normalBalance: 'debit' }, // Fixed-asset disposal Dr
  { code: '8210', nameTh: 'กำไร (ขาดทุน) จากอัตราแลกเปลี่ยน', nameEn: 'FX gain / loss', type: 'expense', normalBalance: 'debit' },
  { code: '9110', nameTh: 'ภาษีเงินได้นิติบุคคล', nameEn: 'Corporate income tax', type: 'expense', normalBalance: 'debit' },
];
