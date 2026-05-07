/**
 * Phase 3 Inventory page — three tabs:
 *   1. Stock view (qty + reorder + low alert)
 *   2. Valuation (sum of cost layers per product/warehouse + drift vs avg cost)
 *   3. Suppliers + Purchase Orders + GRNs
 *
 * Mutations: receive stock, adjust stock, create supplier, create PO, post GRN.
 *
 * No server-side framework calls — all data fetched on the client via api().
 * Loaders + actions deferred to Phase 5 once the auth boundary is in place.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { DatePicker } from "~/components/ui/date-picker";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Boxes,
  ClipboardList,
  Download,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  ScanBarcode,
  Truck,
  Upload,
  Warehouse,
  Pencil,
  PackagePlus,
  Trash2,
  X,
} from "lucide-react";
import { api, API_BASE, downloadFile, formatMoney } from "~/lib/api";
import { useAuth } from "~/lib/auth";
import { useT } from "~/hooks/use-t";
import { useOrgSettings } from "~/hooks/use-org-settings";

type Warehouse = {
  id: string;
  code: string;
  name: string;
  branchCode: string;
  timezone: string;
  isActive: boolean;
};

type StockRow = {
  productId: string;
  productName: string;
  sku: string | null;
  warehouseId: string;
  warehouseCode: string;
  qtyOnHand: number;
  qtyReserved: number;
  reorderPoint: number | null;
  isLow: boolean;
  unitOfMeasure: string;
};

type ValuationLine = {
  productId: string;
  productName: string;
  sku: string | null;
  warehouseId: string;
  warehouseCode: string;
  qtyOnHand: number;
  layerValueCents: number;
  avgCostValueCents: number | null;
  driftCents: number | null;
};

type ValuationResp = {
  lines: ValuationLine[];
  summary: {
    totalLayerValueCents: number;
    totalAvgCostValueCents: number;
    driftCents: number;
  };
};

type Partner = {
  id: string;
  name: string;
  isSupplier: boolean;
  tin: string | null;
  branchCode: string | null;
  vatRegistered: boolean;
  paymentTermsDays: number;
};

type PurchaseOrder = {
  id: string;
  poNumber: string;
  supplierId: string;
  status:
    | "draft"
    | "confirmed"
    | "partial_received"
    | "received"
    | "cancelled";
  orderDate: string;
  totalCents: number;
  currency: string;
};

type Tab = "stock" | "valuation" | "purchasing";

export default function InventoryPage() {
  const t = useT();
  const { settings } = useOrgSettings();
  const thaiMode = settings?.countryMode === "TH";
  const [searchParams] = useSearchParams();
  // ?tab=purchasing&focusPo=<id> from /approvals → land directly on the
  // purchasing tab and surface the targeted PO. focusPo is read by PurchasingTab.
  const initialTab = (searchParams.get("tab") as Tab) || "stock";
  const [tab, setTab] = useState<Tab>(initialTab);
  const focusPoId = searchParams.get("focusPo");
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [selectedWh, setSelectedWh] = useState<string | null>(null);
  const multiWarehouse = !!settings?.featureFlags?.multiWarehouse;

  useEffect(() => {
    api<Warehouse[]>("/api/inventory/warehouses")
      .then((rows) => {
        setWarehouses(rows);
        if (rows[0]) setSelectedWh(rows[0].id);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t.inv_title}</h1>
          <p className="text-sm text-muted-foreground">
            {t.inv_subtitle}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Single-warehouse shops: no picker. The default warehouse is auto-
              selected and acts as the implicit destination on every stock op. */}
          {multiWarehouse && warehouses.length > 1 ? (
            <Select
              value={selectedWh ?? ""}
              onValueChange={(v) => setSelectedWh(v || null)}
            >
              <SelectTrigger size="sm" className="w-[12rem]">
                <SelectValue placeholder={t.inv_warehouse} />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.code} — {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : warehouses[0] ? (
            <span className="text-xs text-muted-foreground">
              {warehouses[0].code} — {warehouses[0].name}
            </span>
          ) : null}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b px-6">
        <TabButton current={tab} value="stock" onClick={setTab} icon={<Boxes className="h-4 w-4" />}>
          {t.inv_tab_stock}
        </TabButton>
        <TabButton current={tab} value="valuation" onClick={setTab} icon={<Package className="h-4 w-4" />}>
          {t.inv_tab_valuation}
        </TabButton>
        <TabButton current={tab} value="purchasing" onClick={setTab} icon={<Truck className="h-4 w-4" />}>
          {t.inv_tab_purchasing}
        </TabButton>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "stock" && <StockTab warehouseId={selectedWh} />}
        {tab === "valuation" && <ValuationTab warehouseId={selectedWh} />}
        {tab === "purchasing" && <PurchasingTab warehouseId={selectedWh} focusPoId={focusPoId} />}
      </div>
    </div>
  );
}

function TabButton({
  current,
  value,
  onClick,
  icon,
  children,
}: {
  current: Tab;
  value: Tab;
  onClick: (v: Tab) => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
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

// ─── Stock tab ──────────────────────────────────────────────────────────────
function StockTab({ warehouseId }: { warehouseId: string | null }) {
  const t = useT();
  const role = useAuth((s) => s.user?.role);
  const canMutate = role === "admin" || role === "manager";
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showLowOnly, setShowLowOnly] = useState(false);

  // Adjust modal state
  const [adjustOpen, setAdjustOpen] = useState<StockRow | null>(null);
  // Receive modal state
  const [receiveOpen, setReceiveOpen] = useState<StockRow | null>(null);
  // Scan-to-receive / scan-to-adjust state
  const [scanOpen, setScanOpen] = useState<"receive" | "adjust" | null>(null);
  // Import modal state
  const [importOpen, setImportOpen] = useState(false);
  // Product create/edit modal — null means closed; "new" for create; row for edit
  const [productOpen, setProductOpen] = useState<"new" | StockRow | null>(null);

  const reload = () => {
    if (!warehouseId) return;
    setLoading(true);
    api<StockRow[]>(`/api/inventory/stock?warehouseId=${warehouseId}`)
      .then((r) => setRows(r))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
  }, [warehouseId]);

  const filtered = useMemo(() => {
    let r = rows;
    if (showLowOnly) r = r.filter((x) => x.isLow);
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(
        (x) => x.productName.toLowerCase().includes(q) || x.sku?.toLowerCase().includes(q),
      );
    }
    return r;
  }, [rows, search, showLowOnly]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Input
            placeholder={t.search_placeholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          variant={showLowOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setShowLowOnly((v) => !v)}
        >
          <AlertTriangle className="h-4 w-4 mr-1" />
          {showLowOnly ? t.inv_show_all : t.inv_low_only}
        </Button>
        {canMutate && (
          <Button variant="outline" size="sm" onClick={() => setProductOpen("new")} title={t.inv_new_product}>
            <PackagePlus className="h-4 w-4 mr-1" />
            {t.inv_new_product}
          </Button>
        )}
        {canMutate && (
          <Button variant="outline" size="sm" onClick={() => setScanOpen("receive")} title={t.inv_scan}>
            <ScanBarcode className="h-4 w-4 mr-1" />
            {t.inv_scan}
          </Button>
        )}
        {canMutate && (
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} title={t.inv_import}>
            <Upload className="h-4 w-4 mr-1" />
            {t.inv_import}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          title={t.inv_export_csv}
          onClick={() =>
            downloadFile(
              `/api/inventory/stock.csv${warehouseId ? `?warehouseId=${warehouseId}` : ""}`,
              `stock-on-hand-${new Date().toISOString().slice(0, 10)}.csv`,
            ).catch((e) => alert(`Download failed: ${e.message}`))
          }
        >
          <Download className="h-4 w-4 mr-1" />
          {t.inv_export_csv}
        </Button>
        <Button variant="outline" size="sm" onClick={reload}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b text-muted-foreground">
              <tr className="text-left">
                <th className="px-4 py-3">{t.inv_product}</th>
                <th className="px-4 py-3">{t.inv_sku}</th>
                <th className="px-4 py-3 text-right">{t.inv_on_hand}</th>
                <th className="px-4 py-3 text-right">{t.inv_reserved}</th>
                <th className="px-4 py-3 text-right">{t.inv_reorder}</th>
                <th className="px-4 py-3 text-right">{t.inv_uom}</th>
                <th className="px-4 py-3 text-right">{t.actions}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.productId} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {r.isLow && (
                        <AlertTriangle className="h-4 w-4 text-orange-500" />
                      )}
                      <span className="font-medium">{r.productName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{r.sku ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.qtyOnHand.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {r.qtyReserved.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {r.reorderPoint?.toLocaleString() ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {r.unitOfMeasure}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {canMutate && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setProductOpen(r)}
                          title={t.inv_edit_product}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {canMutate && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setReceiveOpen(r)}
                        >
                          <ArrowDownCircle className="h-4 w-4 mr-1" />
                          {t.inv_receive}
                        </Button>
                      )}
                      {canMutate && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setAdjustOpen(r)}
                        >
                          <ArrowUpCircle className="h-4 w-4 mr-1" />
                          {t.inv_adjust}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t.inv_no_match}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {receiveOpen && (
        <ReceiveModal
          row={receiveOpen}
          onClose={() => setReceiveOpen(null)}
          onSuccess={() => {
            setReceiveOpen(null);
            reload();
          }}
        />
      )}
      {adjustOpen && (
        <AdjustModal
          row={adjustOpen}
          onClose={() => setAdjustOpen(null)}
          onSuccess={() => {
            setAdjustOpen(null);
            reload();
          }}
        />
      )}
      {scanOpen && (
        <ScanModal
          mode={scanOpen}
          onClose={() => setScanOpen(null)}
          onResolved={(row) => {
            setScanOpen(null);
            if (row) {
              if (scanOpen === "receive") setReceiveOpen(row);
              else setAdjustOpen(row);
            }
          }}
          stockRows={rows}
        />
      )}
      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onSuccess={() => {
            setImportOpen(false);
            reload();
          }}
        />
      )}
      {productOpen && (
        <ProductFormModal
          target={productOpen}
          onClose={() => setProductOpen(null)}
          onSaved={() => {
            setProductOpen(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ScanModal({
  mode,
  onClose,
  onResolved,
  stockRows,
}: {
  mode: "receive" | "adjust";
  onClose: () => void;
  onResolved: (row: StockRow | null) => void;
  stockRows: StockRow[];
}) {
  const t = useT();
  const [barcode, setBarcode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      type Product = { id: string };
      const product = await api<Product>(`/api/products/barcode/${encodeURIComponent(barcode.trim())}`);
      const row = stockRows.find((r) => r.productId === product.id);
      if (!row) {
        setErr(t.inv_scan_no_stock);
      } else {
        onResolved(row);
      }
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t.inv_scan_title(mode)} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t.inv_scan_help}
        </p>
        <Field label={t.inv_scan_label}>
          <Input
            autoFocus
            value={barcode}
            onChange={(e) => setBarcode(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="0012345678905"
            inputMode="numeric"
          />
        </Field>
        {err && <div className="text-sm text-destructive">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button onClick={submit} disabled={busy || barcode.length < 6}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            {t.inv_scan_lookup}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ImportModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useT();
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<null | {
    inserted: number;
    updated: number;
    errors: { row: number; reason: string }[];
  }>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<typeof result>("/api/products/import", {
        method: "POST",
        body: JSON.stringify({ csv }),
      });
      setResult(r);
      if (r && (r.inserted > 0 || r.updated > 0) && r.errors.length === 0) {
        // Success: close after 1.5s so user sees the count
        setTimeout(onSuccess, 1500);
      }
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t.inv_import_title} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{t.inv_import_help}</p>
        <textarea
          className="w-full h-48 rounded-md border bg-background p-2 text-xs font-mono"
          placeholder="name,sku,barcode,priceCents,vatCategory&#10;Bottled Water,BW-001,8851959100015,2000,standard&#10;..."
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        {result && (
          <div className="text-sm space-y-1">
            <div className="text-emerald-600">
              {t.inv_import_inserted(result.inserted, result.updated)}
            </div>
            {result.errors.length > 0 && (
              <div className="text-destructive max-h-32 overflow-y-auto text-xs">
                {result.errors.map((e, i) => (
                  <div key={i}>row {e.row}: {e.reason}</div>
                ))}
              </div>
            )}
          </div>
        )}
        {err && <div className="text-sm text-destructive">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t.close}
          </Button>
          <Button onClick={submit} disabled={busy || csv.trim().length === 0}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            {t.inv_import_button}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ReceiveModal({
  row,
  onClose,
  onSuccess,
}: {
  row: StockRow;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useT();
  const { settings } = useOrgSettings();
  const lotSerialTracking = !!settings?.featureFlags?.lotSerialTracking;
  const [qty, setQty] = useState(1);
  const [unitCostBaht, setUnitCostBaht] = useState(10);
  const [lotCode, setLotCode] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/inventory/receive`, {
        method: "POST",
        body: JSON.stringify({
          productId: row.productId,
          warehouseId: row.warehouseId,
          qty,
          unitCostCents: Math.round(unitCostBaht * 100),
          lotCode: lotCode || undefined,
          expiryDate: expiryDate || undefined,
        }),
      });
      onSuccess();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t.inv_receive_title} — ${row.productName}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t.inv_receive_qty}>
          <Input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
          />
        </Field>
        <Field label={t.inv_receive_unit_cost}>
          <Input
            type="number"
            min={0}
            step={0.01}
            value={unitCostBaht}
            onChange={(e) => setUnitCostBaht(Number(e.target.value))}
          />
        </Field>
        {lotSerialTracking && (
          <>
            <Field label={t.inv_receive_lot}>
              <Input value={lotCode} onChange={(e) => setLotCode(e.target.value)} />
            </Field>
            <Field label={t.inv_receive_expiry}>
              <DatePicker value={expiryDate} onChange={(iso) => setExpiryDate(iso)} />
            </Field>
          </>
        )}
        {err && <div className="text-sm text-destructive">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button onClick={submit} disabled={busy || qty <= 0}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            {t.inv_receive}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AdjustModal({
  row,
  onClose,
  onSuccess,
}: {
  row: StockRow;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useT();
  const [qtyDelta, setQtyDelta] = useState(0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/inventory/adjust`, {
        method: "POST",
        body: JSON.stringify({
          productId: row.productId,
          warehouseId: row.warehouseId,
          qty: qtyDelta,
          reason,
          // Approval needed if it would push qty below zero
          approvedBy: row.qtyOnHand + qtyDelta < 0 ? "manager-web" : undefined,
        }),
      });
      onSuccess();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t.inv_adjust_title} — ${row.productName}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-sm text-muted-foreground">
          {t.inv_adjust_current(row.qtyOnHand)}
        </div>
        <Field label={t.inv_adjust_qty}>
          <Input
            type="number"
            value={qtyDelta}
            onChange={(e) => setQtyDelta(Number(e.target.value))}
          />
        </Field>
        <Field label={t.inv_adjust_reason}>
          <Input
            value={reason}
            placeholder={t.inv_adjust_reason_placeholder}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {err && <div className="text-sm text-destructive">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button onClick={submit} disabled={busy || qtyDelta === 0 || reason.trim().length < 3}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            {t.apply}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Valuation tab ──────────────────────────────────────────────────────────
function ValuationTab({ warehouseId }: { warehouseId: string | null }) {
  const t = useT();
  const { settings } = useOrgSettings();
  const ccy = settings?.currency ?? "THB";
  const [data, setData] = useState<ValuationResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!warehouseId) return;
    setLoading(true);
    api<ValuationResp>(`/api/inventory/valuation?warehouseId=${warehouseId}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [warehouseId]);

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (!data) return <div className="text-muted-foreground">{t.no_orders}</div>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t.val_layer_title}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {formatMoney(data.summary.totalLayerValueCents, ccy)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t.val_avg_title}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {formatMoney(data.summary.totalAvgCostValueCents, ccy)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t.val_drift_title}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={
                "text-2xl font-semibold " +
                (Math.abs(data.summary.driftCents) > 100 ? "text-orange-500" : "")
              }
            >
              {formatMoney(data.summary.driftCents, ccy)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <table className="w-full text-sm">
          <thead className="border-b text-muted-foreground">
            <tr className="text-left">
              <th className="px-4 py-3">{t.inv_product}</th>
              <th className="px-4 py-3 text-right">{t.inv_on_hand}</th>
              <th className="px-4 py-3 text-right">{t.val_layer_value}</th>
              <th className="px-4 py-3 text-right">{t.val_avg_value}</th>
              <th className="px-4 py-3 text-right">{t.val_drift}</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={`${l.productId}-${l.warehouseId}`} className="border-b last:border-0">
                <td className="px-4 py-3">{l.productName}</td>
                <td className="px-4 py-3 text-right tabular-nums">{l.qtyOnHand}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatMoney(l.layerValueCents, ccy)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {l.avgCostValueCents != null ? formatMoney(l.avgCostValueCents, ccy) : "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {l.driftCents != null ? formatMoney(l.driftCents, ccy) : "—"}
                </td>
              </tr>
            ))}
            {data.lines.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  {t.val_no_stock}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ─── Purchasing tab ─────────────────────────────────────────────────────────
function PurchasingTab({
  warehouseId,
  focusPoId,
}: {
  warehouseId: string | null;
  focusPoId?: string | null;
}) {
  const t = useT();
  const [suppliers, setSuppliers] = useState<Partner[]>([]);
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [createSupplierOpen, setCreateSupplierOpen] = useState(false);
  const [createPoOpen, setCreatePoOpen] = useState(false);

  const reload = () => {
    setLoading(true);
    Promise.all([
      api<Partner[]>("/api/purchasing/partners?role=supplier"),
      api<PurchaseOrder[]>("/api/purchasing/purchase-orders?limit=20"),
    ])
      .then(([s, p]) => {
        setSuppliers(s);
        setPos(p);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
  }, []);

  // Scroll to + briefly highlight the focused PO when arriving from /approvals.
  useEffect(() => {
    if (!focusPoId || loading) return;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-po-id="${focusPoId}"]`);
      if (el) (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    return () => clearTimeout(t);
  }, [focusPoId, loading]);

  return (
    <div className="space-y-6">
      {/* Suppliers */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">{t.pur_suppliers}</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {t.pur_suppliers_sub}
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateSupplierOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            {t.pur_new_supplier}
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-muted-foreground">
                <tr className="text-left">
                  <th className="px-2 py-2">{t.inv_product /* reused as Name header */}</th>
                  <th className="px-2 py-2">TIN</th>
                  <th className="px-2 py-2">{t.pos_buyer_branch}</th>
                  <th className="px-2 py-2">VAT</th>
                  <th className="px-2 py-2 text-right">{t.pur_terms_short}</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="px-2 py-2 font-medium">{s.name}</td>
                    <td className="px-2 py-2 text-muted-foreground tabular-nums">
                      {s.tin ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground tabular-nums">
                      {s.branchCode ?? "—"}
                    </td>
                    <td className="px-2 py-2">{s.vatRegistered ? t.yes : t.no}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {s.paymentTermsDays}d
                    </td>
                  </tr>
                ))}
                {suppliers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">
                      {t.pur_no_suppliers}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Purchase orders */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">{t.pur_pos}</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {t.pur_pos_sub}
            </p>
          </div>
          <Button
            size="sm"
            disabled={suppliers.length === 0 || !warehouseId}
            onClick={() => setCreatePoOpen(true)}
          >
            <ClipboardList className="h-4 w-4 mr-1" />
            {t.pur_new_po}
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-muted-foreground">
                <tr className="text-left">
                  <th className="px-2 py-2">PO #</th>
                  <th className="px-2 py-2">{t.pur_po_supplier}</th>
                  <th className="px-2 py-2">{t.pur_po_order_date}</th>
                  <th className="px-2 py-2">{t.status}</th>
                  <th className="px-2 py-2 text-right">{t.pur_po_total}</th>
                  <th className="px-2 py-2 text-right">{t.actions}</th>
                </tr>
              </thead>
              <tbody>
                {pos.map((p) => {
                  const sup = suppliers.find((s) => s.id === p.supplierId);
                  const focused = p.id === focusPoId;
                  return (
                    <tr
                      key={p.id}
                      data-po-id={p.id}
                      className={`border-b last:border-0 ${
                        focused ? "bg-primary/5 ring-2 ring-primary ring-inset" : ""
                      }`}
                    >
                      <td className="px-2 py-2 font-mono text-xs">{p.poNumber}</td>
                      <td className="px-2 py-2">{sup?.name ?? "—"}</td>
                      <td className="px-2 py-2 text-muted-foreground tabular-nums">
                        {p.orderDate}
                      </td>
                      <td className="px-2 py-2">
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatMoney(p.totalCents, p.currency)}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {p.status === "draft" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                              await api(`/api/purchasing/purchase-orders/${p.id}/confirm`, {
                                method: "POST",
                                body: JSON.stringify({ confirmedBy: "web-user" }),
                              });
                              reload();
                            }}
                          >
                            {t.confirm}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {pos.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                      {t.pur_po_no_pos}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {createSupplierOpen && (
        <CreateSupplierModal
          onClose={() => setCreateSupplierOpen(false)}
          onSuccess={() => {
            setCreateSupplierOpen(false);
            reload();
          }}
        />
      )}
      {createPoOpen && warehouseId && (
        <CreatePoModal
          warehouseId={warehouseId}
          suppliers={suppliers}
          onClose={() => setCreatePoOpen(false)}
          onSuccess={() => {
            setCreatePoOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: PurchaseOrder["status"] }) {
  const t = useT();
  const cls: Record<PurchaseOrder["status"], string> = {
    draft: "bg-muted text-muted-foreground",
    confirmed: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
    partial_received: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    received: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    cancelled: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  };
  const label: Record<PurchaseOrder["status"], string> = {
    draft: t.state_draft,
    confirmed: t.state_confirmed,
    partial_received: t.state_partial_received,
    received: t.state_received,
    cancelled: t.state_cancelled,
  };
  return (
    <span className={"inline-flex items-center rounded px-2 py-0.5 text-xs font-medium " + cls[status]}>
      {label[status]}
    </span>
  );
}

function CreateSupplierModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [tin, setTin] = useState("");
  const [branchCode, setBranchCode] = useState("00000");
  const [vatRegistered, setVatRegistered] = useState(true);
  const [paymentTermsDays, setPaymentTermsDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/purchasing/partners", {
        method: "POST",
        body: JSON.stringify({
          name,
          isSupplier: true,
          tin: tin || undefined,
          branchCode,
          vatRegistered,
          paymentTermsDays,
        }),
      });
      onSuccess();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t.pur_new_supplier} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t.pur_legal_name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t.pur_tin_label}>
          <Input
            value={tin}
            placeholder="0105551234567"
            maxLength={13}
            onChange={(e) => setTin(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </Field>
        <Field label={t.pur_branch_code}>
          <Input
            value={branchCode}
            maxLength={5}
            onChange={(e) => setBranchCode(e.target.value.replace(/[^0-9]/g, "").padStart(5, "0"))}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={vatRegistered}
            onChange={(e) => setVatRegistered(e.target.checked)}
          />
          {t.pur_vat_registered}
        </label>
        <Field label={t.pur_payment_terms}>
          <Input
            type="number"
            value={paymentTermsDays}
            onChange={(e) => setPaymentTermsDays(Number(e.target.value))}
          />
        </Field>
        {err && <div className="text-sm text-destructive">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button onClick={submit} disabled={busy || !name}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            {t.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CreatePoModal({
  warehouseId,
  suppliers,
  onClose,
  onSuccess,
}: {
  warehouseId: string;
  suppliers: Partner[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useT();
  type Product = {
    id: string;
    name: string;
    priceCents: number;
  };
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<{ productId: string; qty: number; priceBaht: number }[]>([
    { productId: "", qty: 1, priceBaht: 10 },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Product[]>("/api/products").then((rows) => {
      setProducts(rows);
      if (rows[0]) {
        setLines([{ productId: rows[0].id, qty: 1, priceBaht: rows[0].priceCents / 100 }]);
      }
    });
  }, []);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/purchasing/purchase-orders", {
        method: "POST",
        body: JSON.stringify({
          supplierId,
          destinationWarehouseId: warehouseId,
          createdBy: "web-user",
          lines: lines
            .filter((l) => l.productId && l.qty > 0)
            .map((l) => ({
              productId: l.productId,
              qtyOrdered: l.qty,
              unitPriceCents: Math.round(l.priceBaht * 100),
            })),
        }),
      });
      onSuccess();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t.pur_new_po} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t.pur_po_supplier}>
          <Select value={supplierId} onValueChange={(v) => setSupplierId(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder={t.pur_po_supplier} />
            </SelectTrigger>
            <SelectContent>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="space-y-2">
          <div className="text-sm font-medium">{t.pur_po_lines}</div>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <div className="flex-1">
                <Select
                  value={l.productId}
                  onValueChange={(v) => {
                    const next = [...lines];
                    next[i] = { ...l, productId: v ?? "" };
                    setLines(next);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t.inv_product} />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Input
                type="number"
                min={1}
                className="w-20"
                value={l.qty}
                onChange={(e) => {
                  const next = [...lines];
                  next[i] = { ...l, qty: Number(e.target.value) };
                  setLines(next);
                }}
              />
              <Input
                type="number"
                min={0}
                step={0.01}
                className="w-24"
                value={l.priceBaht}
                onChange={(e) => {
                  const next = [...lines];
                  next[i] = { ...l, priceBaht: Number(e.target.value) };
                  setLines(next);
                }}
              />
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setLines([...lines, { productId: products[0]?.id ?? "", qty: 1, priceBaht: 10 }])
            }
          >
            <Plus className="h-4 w-4 mr-1" />
            {t.pur_po_add_line}
          </Button>
        </div>

        {err && <div className="text-sm text-destructive">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button onClick={submit} disabled={busy || !supplierId || lines.length === 0}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            {t.pur_po_create}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Modal + Field utilities ────────────────────────────────────────────────
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
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
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      {children}
    </label>
  );
}

// ─── Product create / edit modal ────────────────────────────────────────────
type ModifierOptionEdit = { id: string; name: string; priceDeltaCents: number };
type ModifierGroupEdit = {
  id: string;
  name: string;
  required: boolean;
  multi: boolean;
  options: ModifierOptionEdit[];
};
type ProductFull = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  priceCents: number;
  currency: string;
  category: string | null;
  vatCategory: "standard" | "zero" | "exempt";
  unitOfMeasure: string;
  reorderPoint: number | null;
  reorderQty: number | null;
  imageUrl: string | null;
  isActive: boolean;
  modifierGroups?: ModifierGroupEdit[];
};

function ProductFormModal({
  target,
  onClose,
  onSaved,
}: {
  target: "new" | StockRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const isNew = target === "new";
  const [hydrating, setHydrating] = useState(!isNew);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    sku: "",
    barcode: "",
    priceCents: 0,
    currency: "THB",
    category: "",
    vatCategory: "standard" as ProductFull["vatCategory"],
    unitOfMeasure: "piece",
    reorderPoint: "",
    reorderQty: "",
    imageUrl: "",
    isActive: true,
    modifierGroups: [] as ModifierGroupEdit[],
  });

  // Hydrate when editing — StockRow doesn't have all fields, fetch the full record.
  useEffect(() => {
    if (isNew) return;
    const id = (target as StockRow).productId;
    let alive = true;
    (async () => {
      try {
        const p = await api<ProductFull>(`/api/products/${id}`);
        if (!alive) return;
        setForm({
          name: p.name,
          sku: p.sku ?? "",
          barcode: p.barcode ?? "",
          priceCents: p.priceCents,
          currency: p.currency,
          category: p.category ?? "",
          vatCategory: p.vatCategory,
          unitOfMeasure: p.unitOfMeasure,
          reorderPoint: p.reorderPoint == null ? "" : String(p.reorderPoint),
          reorderQty: p.reorderQty == null ? "" : String(p.reorderQty),
          imageUrl: p.imageUrl ?? "",
          isActive: p.isActive,
          modifierGroups: p.modifierGroups ?? [],
        });
      } catch (e: any) {
        if (alive) setErr(e.message ?? String(e));
      } finally {
        if (alive) setHydrating(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [target, isNew]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Strip blank-named groups/options before sending so the editor's
      // ergonomic empty rows don't fail server validation.
      const cleanedGroups: ModifierGroupEdit[] = form.modifierGroups
        .map((g) => ({
          ...g,
          name: g.name.trim(),
          options: g.options
            .map((o) => ({ ...o, name: o.name.trim() }))
            .filter((o) => o.name.length > 0),
        }))
        .filter((g) => g.name.length > 0 && g.options.length > 0);

      const body = {
        name: form.name,
        sku: form.sku || null,
        barcode: form.barcode || null,
        priceCents: Math.round(Number(form.priceCents) || 0),
        currency: form.currency,
        category: form.category || null,
        vatCategory: form.vatCategory,
        unitOfMeasure: form.unitOfMeasure,
        reorderPoint: form.reorderPoint === "" ? null : Number(form.reorderPoint),
        reorderQty: form.reorderQty === "" ? null : Number(form.reorderQty),
        imageUrl: form.imageUrl || null,
        isActive: form.isActive,
        modifierGroups: cleanedGroups,
      };
      if (isNew) {
        await api(`/api/products`, { method: "POST", body: JSON.stringify(body) });
      } else {
        await api(`/api/products/${(target as StockRow).productId}`, {
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

  const deactivate = async () => {
    if (isNew) return;
    if (!confirm(t.inv_deactivate + "?")) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/products/${(target as StockRow).productId}`, { method: "DELETE" });
      onSaved();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  if (hydrating) {
    return (
      <Modal title={t.inv_edit_product} onClose={onClose}>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={isNew ? t.inv_new_product : t.inv_edit_product} onClose={onClose}>
      <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
        <Field label={t.inv_product_name}>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            autoFocus
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.inv_product_sku}>
            <Input
              value={form.sku}
              onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
            />
          </Field>
          <Field label={t.inv_product_barcode}>
            <Input
              value={form.barcode}
              onChange={(e) =>
                setForm((f) => ({ ...f, barcode: e.target.value.replace(/\D/g, "").slice(0, 18) }))
              }
              placeholder="EAN-13 / UPC-A"
            />
          </Field>
        </div>
        <div className="grid grid-cols-[2fr_1fr] gap-3">
          <Field label={t.inv_product_price}>
            <Input
              type="number"
              min={0}
              step={1}
              value={form.priceCents}
              onChange={(e) => setForm((f) => ({ ...f, priceCents: Number(e.target.value) }))}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              {formatMoney(form.priceCents, form.currency)}
            </p>
          </Field>
          <Field label="Currency">
            <Input
              value={form.currency}
              onChange={(e) =>
                setForm((f) => ({ ...f, currency: e.target.value.toUpperCase().slice(0, 3) }))
              }
              maxLength={3}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.inv_product_category}>
            <Input
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            />
          </Field>
          <Field label={t.inv_product_uom}>
            <Input
              value={form.unitOfMeasure}
              onChange={(e) => setForm((f) => ({ ...f, unitOfMeasure: e.target.value }))}
              placeholder="piece / kg / litre"
            />
          </Field>
        </div>
        <Field label={t.inv_product_vat_category}>
          <Select
            value={form.vatCategory}
            onValueChange={(v) =>
              setForm((f) => ({ ...f, vatCategory: v as ProductFull["vatCategory"] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">{t.inv_vat_standard}</SelectItem>
              <SelectItem value="zero">{t.inv_vat_zero}</SelectItem>
              <SelectItem value="exempt">{t.inv_vat_exempt}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.inv_product_reorder_pt}>
            <Input
              type="number"
              min={0}
              step="0.001"
              value={form.reorderPoint}
              onChange={(e) => setForm((f) => ({ ...f, reorderPoint: e.target.value }))}
            />
          </Field>
          <Field label={t.inv_product_reorder_qty}>
            <Input
              type="number"
              min={0}
              step="0.001"
              value={form.reorderQty}
              onChange={(e) => setForm((f) => ({ ...f, reorderQty: e.target.value }))}
            />
          </Field>
        </div>
        <Field label="Image URL">
          <Input
            value={form.imageUrl}
            onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
            placeholder="https://…"
          />
        </Field>
        <ModifiersEditor
          groups={form.modifierGroups}
          onChange={(groups) => setForm((f) => ({ ...f, modifierGroups: groups }))}
        />
        {!isNew && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="h-4 w-4"
            />
            Active
          </label>
        )}
        {err && <div className="text-sm text-destructive">{err}</div>}
        <div className="flex items-center justify-between pt-2">
          {!isNew ? (
            <Button variant="ghost" onClick={deactivate} disabled={busy} className="text-destructive">
              {t.inv_deactivate}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t.cancel}
            </Button>
            <Button onClick={submit} disabled={busy || !form.name.trim()}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              {isNew ? t.inv_create : t.inv_save}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── Modifier groups editor (sub-component of ProductFormModal) ─────────────
function ModifiersEditor({
  groups,
  onChange,
}: {
  groups: ModifierGroupEdit[];
  onChange: (next: ModifierGroupEdit[]) => void;
}) {
  const t = useT();
  const newId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  const addGroup = () =>
    onChange([
      ...groups,
      { id: newId(), name: "", required: false, multi: false, options: [] },
    ]);
  const removeGroup = (idx: number) =>
    onChange(groups.filter((_, i) => i !== idx));
  const updateGroup = (idx: number, patch: Partial<ModifierGroupEdit>) =>
    onChange(groups.map((g, i) => (i === idx ? { ...g, ...patch } : g)));
  const addOption = (gIdx: number) =>
    updateGroup(gIdx, {
      options: [
        ...groups[gIdx].options,
        { id: newId(), name: "", priceDeltaCents: 0 },
      ],
    });
  const removeOption = (gIdx: number, oIdx: number) =>
    updateGroup(gIdx, { options: groups[gIdx].options.filter((_, i) => i !== oIdx) });
  const updateOption = (
    gIdx: number,
    oIdx: number,
    patch: Partial<ModifierOptionEdit>,
  ) =>
    updateGroup(gIdx, {
      options: groups[gIdx].options.map((o, i) =>
        i === oIdx ? { ...o, ...patch } : o,
      ),
    });

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">{t.inv_modifiers}</div>
          <div className="text-[11px] text-muted-foreground">{t.inv_modifiers_help}</div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={addGroup}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t.inv_modifiers_add_group}
        </Button>
      </div>

      {groups.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground py-2">—</p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g, gIdx) => (
            <li key={g.id} className="rounded-md border bg-background p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  className="flex-1 h-8"
                  value={g.name}
                  onChange={(e) => updateGroup(gIdx, { name: e.target.value })}
                  placeholder={t.inv_modifier_group_name}
                />
                <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px]">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={g.required}
                    onChange={(e) => updateGroup(gIdx, { required: e.target.checked })}
                  />
                  {t.inv_modifier_group_required}
                </label>
                <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px]">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={g.multi}
                    onChange={(e) => updateGroup(gIdx, { multi: e.target.checked })}
                  />
                  {t.inv_modifier_group_multi}
                </label>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive"
                  onClick={() => removeGroup(gIdx)}
                  aria-label={t.inv_modifier_remove}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ul className="mt-2 space-y-1.5 pl-2">
                {g.options.map((o, oIdx) => (
                  <li key={o.id} className="flex items-center gap-2">
                    <Input
                      className="flex-1 h-7 text-[13px]"
                      value={o.name}
                      onChange={(e) =>
                        updateOption(gIdx, oIdx, { name: e.target.value })
                      }
                      placeholder={t.inv_modifier_option_name}
                    />
                    <Input
                      type="number"
                      step={1}
                      className="h-7 w-24 text-[13px] text-right"
                      value={o.priceDeltaCents}
                      onChange={(e) =>
                        updateOption(gIdx, oIdx, {
                          priceDeltaCents: Math.round(Number(e.target.value) || 0),
                        })
                      }
                      title={t.inv_modifier_option_delta}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground"
                      onClick={() => removeOption(gIdx, oIdx)}
                      aria-label={t.inv_modifier_remove}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
                <li>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[12px]"
                    onClick={() => addOption(gIdx)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    {t.inv_modifier_add_option}
                  </Button>
                </li>
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
