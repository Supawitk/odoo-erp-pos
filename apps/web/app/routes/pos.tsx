import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { io, type Socket } from "socket.io-client";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Separator } from "~/components/ui/separator";
import {
  Search,
  ShoppingCart,
  Trash2,
  Minus,
  Plus,
  Receipt,
  Loader2,
  QrCode,
  RotateCcw,
  User,
  Mail,
  Pause,
  Play,
} from "lucide-react";
import { API_BASE, api, formatMoney, getDevUserId, openAuthed } from "~/lib/api";
import { useOrgSettings } from "~/hooks/use-org-settings";
import { useT } from "~/hooks/use-t";

// ----- types mirrored from API -----
type ModifierOption = { id: string; name: string; priceDeltaCents: number };
type ModifierGroup = {
  id: string;
  name: string;
  required: boolean;
  multi: boolean;
  options: ModifierOption[];
};
type ChosenModifier = { groupName: string; name: string; priceDeltaCents: number };

type Product = {
  id: string;
  name: string;
  barcode: string | null;
  sku: string | null;
  category: string | null;
  priceCents: number;
  currency: string;
  stockQty: number;
  imageUrl: string | null;
  modifierGroups?: ModifierGroup[];
};
type Session = {
  id: string;
  userId: string;
  openingBalanceCents: number;
  closingBalanceCents: number | null;
  status: "open" | "closing" | "closed";
  deviceId: string | null;
};
type OrderRow = {
  id: string;
  sessionId: string;
  totalCents: number;
  currency: string;
  paymentMethod: string;
  status: string;
  documentType: "RE" | "ABB" | "TX" | "CN";
  documentNumber: string | null;
  orderLines: Array<{ name: string; qty: number; unitPriceCents: number }>;
  createdAt: string;
};
type CreateOrderResponse = OrderRow & {
  taxCents: number;
  subtotalCents: number;
  vatBreakdown: { taxableNetCents: number; vatCents: number; grossCents: number };
  documentDecision: { type: string; suggestAskTIN: boolean; reason: string };
  promptpayQr: string | null;
};
type CartLine = {
  /** Stable per-cart-line id — distinct from productId because the same product
   *  with different modifier picks lives as separate cart lines. */
  lineKey: string;
  productId: string;
  name: string;
  qty: number;
  /** Base unit price; the line's effective price = unitPriceCents + Σ deltas. */
  unitPriceCents: number;
  vatCategory?: "standard" | "zero_rated" | "exempt";
  modifiers?: ChosenModifier[];
};

export default function PosPage() {
  const userId = useMemo(() => getDevUserId(), []);
  const { settings } = useOrgSettings();
  const multiBranch = !!settings?.featureFlags?.multiBranch;
  const restaurantMode = !!settings?.featureFlags?.restaurantMode;
  // ?focusOrder=<id> from /approvals — used to scroll the recent-orders strip
  // and open the refund modal so the approver can re-submit immediately.
  const [searchParams] = useSearchParams();
  const focusOrderId = searchParams.get("focusOrder");
  const t = useT();
  const thaiMode = settings?.countryMode === "TH";
  const currency = settings?.currency ?? "THB";
  const vatRate = settings?.vatRegistered ? (settings?.vatRate ?? 0.07) : 0;
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const filteredProducts = useMemo(
    () => (activeCategory ? products.filter((p) => p.category === activeCategory) : products),
    [products, activeCategory],
  );
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartDiscountCents, setCartDiscountCents] = useState(0);
  // Modifier picker — opens when an added product has modifier groups.
  const [modPicker, setModPicker] = useState<Product | null>(null);
  // Restaurant mode (Pro flag) — null/empty when off so retail orders aren't tagged.
  const [orderType, setOrderType] = useState<"dine_in" | "takeout" | "delivery" | "">("");
  const [tableNumber, setTableNumber] = useState("");
  const [tipCents, setTipCents] = useState(0);
  const [splitOpen, setSplitOpen] = useState(false);
  const [recentOrders, setRecentOrders] = useState<OrderRow[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [openingFloat, setOpeningFloat] = useState("10000");
  const [tendered, setTendered] = useState("");
  const [closeCount, setCloseCount] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 🇹🇭 Buyer capture (TX invoice mode)
  const [buyerOpen, setBuyerOpen] = useState(false);
  const [buyerName, setBuyerName] = useState("");
  const [buyerTin, setBuyerTin] = useState("");
  const [buyerBranch, setBuyerBranch] = useState("");
  const [buyerAddress, setBuyerAddress] = useState("");
  // PromptPay / CN modals
  const [qrModal, setQrModal] = useState<CreateOrderResponse | null>(null);
  const [refundTarget, setRefundTarget] = useState<OrderRow | null>(null);
  const [emailTarget, setEmailTarget] = useState<OrderRow | null>(null);
  const [holdOpen, setHoldOpen] = useState(false);
  const [recallOpen, setRecallOpen] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  const [refundReason, setRefundReason] = useState("");
  const socketRef = useRef<Socket | null>(null);
  const seenMessageIds = useRef<Set<string>>(new Set());
  const focusedRef = useRef(false);

  // ---- load current session + products on mount ----
  useEffect(() => {
    (async () => {
      try {
        const [s, p] = await Promise.all([
          api<Session | null>(`/api/pos/sessions/current?userId=${userId}`),
          api<Product[]>(`/api/products?limit=100`),
        ]);
        setSession(s);
        setProducts(p);
        if (s) {
          const [orders, held] = await Promise.all([
            api<OrderRow[]>(`/api/pos/orders?sessionId=${s.id}&limit=10`),
            api<unknown[]>(`/api/pos/held-carts?sessionId=${s.id}`),
          ]);
          setRecentOrders(orders);
          setHeldCount(Array.isArray(held) ? held.length : 0);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoadingSession(false);
      }
    })();
  }, [userId]);

  // ---- deep-link focus from /approvals ----
  // When the page mounts with ?focusOrder=<id>, fetch that specific order
  // (it might pre-date the current session and not be in recentOrders), then
  // open the refund modal pre-filled so the approver can re-submit one tap.
  useEffect(() => {
    if (!focusOrderId || focusedRef.current) return;
    focusedRef.current = true;
    (async () => {
      try {
        const o = await api<OrderRow>(`/api/pos/orders/${focusOrderId}`);
        if (o.status === "paid" && o.documentType !== "CN") {
          setRefundTarget(o);
        } else {
          setToast(`Order ${o.documentNumber ?? o.id.slice(0, 8)} — already ${o.status}`);
          setTimeout(() => setToast(null), 3500);
        }
        // Scroll the matching card into view if it's in the recent strip.
        setTimeout(() => {
          const el = document.querySelector(`[data-order-id="${focusOrderId}"]`);
          if (el) (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
        }, 300);
      } catch {
        // Order not visible to this user / session — silently no-op.
      }
    })();
  }, [focusOrderId]);

  // ---- socket.io live broadcast ----
  useEffect(() => {
    const sock = io(API_BASE, { transports: ["websocket"], reconnection: true });
    socketRef.current = sock;
    sock.on("pos:order:created", (payload: { messageId: string; orderId: string; totalCents: number; currency: string }) => {
      if (seenMessageIds.current.has(payload.messageId)) return;
      seenMessageIds.current.add(payload.messageId);
      setToast(`Order broadcast ${formatMoney(payload.totalCents, payload.currency)}`);
      setTimeout(() => setToast(null), 2500);
      if (session) {
        api<OrderRow[]>(`/api/pos/orders?sessionId=${session.id}&limit=10`).then(setRecentOrders).catch(() => {});
      }
    });
    return () => { sock.disconnect(); };
  }, [session?.id]);

  // ---- debounced product search ----
  useEffect(() => {
    const q = search.trim();
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const endpoint = q ? `/api/products/search?q=${encodeURIComponent(q)}` : `/api/products?limit=100`;
        const res = await fetch(`${API_BASE}${endpoint}`, { signal: ctrl.signal });
        if (!res.ok) return;
        setProducts(await res.json());
      } catch {}
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [search]);

  // ---- cart helpers ----
  // Effective unit price = base + sum of selected modifier deltas. Used for
  // both the cart UI rollup and the client-side preview.
  const lineUnitPrice = (l: CartLine) =>
    l.unitPriceCents +
    (l.modifiers ?? []).reduce((s, m) => s + m.priceDeltaCents, 0);

  /** Stable signature for "same product + same modifier picks" merging. */
  const modifiersSig = (mods?: ChosenModifier[]) =>
    !mods || mods.length === 0
      ? ""
      : [...mods]
          .map((m) => `${m.groupName}::${m.name}::${m.priceDeltaCents}`)
          .sort()
          .join("|");

  const newLineKey = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  /** Push a product into the cart with a (possibly empty) modifier set. */
  const pushCartLine = (p: Product, modifiers?: ChosenModifier[]) => {
    setCart((prev) => {
      const sig = modifiersSig(modifiers);
      const i = prev.findIndex(
        (l) => l.productId === p.id && modifiersSig(l.modifiers) === sig,
      );
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        return next;
      }
      return [
        ...prev,
        {
          lineKey: newLineKey(),
          productId: p.id,
          name: p.name,
          qty: 1,
          unitPriceCents: p.priceCents,
          modifiers: modifiers && modifiers.length > 0 ? modifiers : undefined,
        },
      ];
    });
  };

  /** Tap-to-add. Opens the modifier picker when the product has groups. */
  const addToCart = (p: Product) => {
    if (p.modifierGroups && p.modifierGroups.length > 0) {
      setModPicker(p);
      return;
    }
    pushCartLine(p);
  };
  const changeQty = (lineKey: string, delta: number) =>
    setCart((prev) =>
      prev
        .map((l) => (l.lineKey === lineKey ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    );
  const removeLine = (lineKey: string) =>
    setCart((prev) => prev.filter((l) => l.lineKey !== lineKey));
  const clearCart = () => setCart([]);

  // Client-side preview only — server is authoritative. VAT follows org rate;
  // falls back to 7% if settings haven't loaded yet. Modifier deltas are
  // included via lineUnitPrice() so the preview matches what the server bills.
  const subtotalPreview = cart.reduce((s, l) => s + lineUnitPrice(l) * l.qty, 0);
  const discountedBase = Math.max(0, subtotalPreview - cartDiscountCents);
  const vatPreview = Math.round(discountedBase * vatRate);
  const totalPreview = discountedBase + vatPreview;
  const change = tendered ? Math.max(0, parseInt(tendered, 10) - totalPreview) : 0;

  const buildBuyer = () => {
    if (!buyerTin && !buyerName) return undefined;
    // Single-branch shops never see the branch input; the head-office code
    // '00000' is the legally-correct §86/4 placeholder for buyers without
    // a branch division.
    const branch = multiBranch ? (buyerBranch || undefined) : "00000";
    return {
      name: buyerName || undefined,
      tin: buyerTin || undefined,
      branch,
      address: buyerAddress || undefined,
    };
  };

  // ---- session actions ----
  const openSession = async () => {
    setError(null);
    setProcessing(true);
    try {
      const s = await api<Session>(`/api/pos/sessions/open`, {
        method: "POST",
        body: JSON.stringify({
          userId,
          openingBalanceCents: parseInt(openingFloat, 10) || 0,
          deviceId: "web-pos",
        }),
      });
      setSession(s);
      setRecentOrders([]);
    } catch (e: any) { setError(e.message); }
    finally { setProcessing(false); }
  };

  const closeSession = async () => {
    if (!session) return;
    setError(null);
    setProcessing(true);
    try {
      await api(`/api/pos/sessions/${session.id}/close`, {
        method: "POST",
        body: JSON.stringify({ countedBalanceCents: parseInt(closeCount, 10) || 0 }),
      });
      setSession(null);
      setRecentOrders([]);
      setCloseCount("");
    } catch (e: any) { setError(e.message); }
    finally { setProcessing(false); }
  };

  // ---- checkout ----
  const checkout = async (method: "cash" | "card" | "promptpay") => {
    if (!session || cart.length === 0) return;
    setError(null);
    setProcessing(true);
    try {
      const totalDue = totalPreview + tipCents;
      const body: Record<string, unknown> = {
        offlineId: crypto.randomUUID(),
        sessionId: session.id,
        lines: cart,
        cartDiscountCents: cartDiscountCents > 0 ? cartDiscountCents : undefined,
        currency,
        ...(restaurantMode && orderType ? { orderType } : {}),
        ...(restaurantMode && orderType === "dine_in" && tableNumber.trim()
          ? { tableNumber: tableNumber.trim() }
          : {}),
        ...(restaurantMode && tipCents > 0 ? { tipCents } : {}),
        payment: (() => {
          // Tip is non-VAT, paid on top — totalDue = totalPreview + tip.
          if (method === "cash") {
            const paid = parseInt(tendered, 10) || totalDue;
            if (paid < totalDue) throw new Error("Cash tendered is less than total");
            return { method: "cash", amountCents: paid, tenderedCents: paid, changeCents: paid - totalDue };
          }
          if (method === "promptpay") return { method: "promptpay", amountCents: totalDue };
          return { method: "card", amountCents: totalDue, cardLast4: "4242" };
        })(),
      };
      const buyer = buildBuyer();
      if (buyer) body.buyer = buyer;

      const resp = await api<CreateOrderResponse>(`/api/pos/orders`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      clearCart();
      setCartDiscountCents(0);
      setTipCents(0);
      setTableNumber("");
      // Keep orderType — restaurants typically take many of the same type in a row.
      setTendered("");
      setBuyerName("");
      setBuyerTin("");
      setBuyerBranch("");
      setBuyerAddress("");
      setBuyerOpen(false);
      setToast(`${resp.documentType} ${resp.documentNumber} · ${formatMoney(resp.totalCents, resp.currency)}`);
      setTimeout(() => setToast(null), 3500);
      if (method === "promptpay" && resp.promptpayQr) {
        setQrModal(resp);
      } else {
        // Auto-open printable receipt in a new tab. Uses openAuthed because
        // the receipt route is JWT-guarded and a plain window.open() loses
        // the bearer token.
        openAuthed(`/api/pos/receipts/${resp.id}.html`).catch((e) =>
          setError(`Receipt failed: ${e.message}`),
        );
      }
    } catch (e: any) { setError(e.message); }
    finally { setProcessing(false); }
  };

  // ---- refund ----
  const doRefund = async () => {
    if (!refundTarget) return;
    setError(null);
    setProcessing(true);
    try {
      const cn = await api<{ documentNumber: string; totalCents: number }>(
        `/api/pos/orders/${refundTarget.id}/refund`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: refundReason || "no reason supplied",
            approvedBy: userId,
          }),
        },
      );
      setToast(`Credit note ${cn.documentNumber} issued`);
      setTimeout(() => setToast(null), 3500);
      setRefundTarget(null);
      setRefundReason("");
      if (session) {
        const orders = await api<OrderRow[]>(`/api/pos/orders?sessionId=${session.id}&limit=10`);
        setRecentOrders(orders);
      }
    } catch (e: any) {
      // Tier-validation gate fired — the refund didn't post yet, but a pending
      // review is sitting in the manager's /approvals inbox. Tell the cashier
      // their request was sent rather than spitting the raw API error.
      const apiErr = e?.body?.error as string | undefined;
      if (apiErr === "APPROVAL_REQUIRED") {
        setRefundTarget(null);
        setRefundReason("");
        setToast(
          thaiMode
            ? "ส่งคำขอคืนเงินให้ผู้จัดการอนุมัติแล้ว"
            : "Refund sent for manager approval — they'll review at /approvals",
        );
        setTimeout(() => setToast(null), 5000);
      } else {
        setError(e.message);
      }
    }
    finally { setProcessing(false); }
  };

  // ---- render: no-session state ----
  if (loadingSession) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t.nav_pos}</h1>
          <p className="text-muted-foreground">{t.pos_no_session}</p>
        </div>
        <Card>
          <CardHeader><CardTitle>{t.pos_open_title}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t.pos_open_label}</label>
              <Input
                type="number"
                inputMode="numeric"
                pattern="[0-9]*"
                value={openingFloat}
                onChange={(e) => setOpeningFloat(e.target.value)}
                placeholder="10000"
                className="h-12 text-lg"
              />
              <p className="text-xs text-muted-foreground">{formatMoney(parseInt(openingFloat, 10) || 0, currency)}</p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              onClick={openSession}
              disabled={processing}
              className="w-full h-12 text-base touch-manipulation"
            >
              {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : t.pos_open_button}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- render: active POS ----
  // Use svh (small-viewport height) so iPad Safari doesn't double-count the
  // address bar when it slides in/out. Falls back to vh on browsers without
  // svh support.
  return (
    <div
      className="flex flex-col gap-4 [-webkit-tap-highlight-color:transparent] h-[calc(100vh-5.5rem)] supports-[height:100svh]:h-[calc(100svh-5.5rem)]"
    >
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.nav_pos}</h1>
          <p className="text-xs text-muted-foreground">
            {thaiMode ? "รอบ" : "Session"} {session.id.slice(0, 8)} • {formatMoney(session.openingBalanceCents, currency)} •{" "}
            <span className="text-green-600">● {thaiMode ? "เปิดอยู่" : "open"}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder={t.pos_close_label}
            value={closeCount}
            onChange={(e) => setCloseCount(e.target.value)}
            className="h-11 w-40 text-base"
          />
          <Button
            variant="outline"
            onClick={closeSession}
            disabled={processing || !closeCount}
            className="h-11 touch-manipulation"
          >
            {t.pos_close_session}
          </Button>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden md:grid-cols-[1fr_360px] lg:grid-cols-[1fr_420px]">
        {/* ---- Products ---- */}
        <Card className="flex flex-col overflow-hidden">
          <CardHeader className="shrink-0 pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t.pos_search_products}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-11 pl-10 text-base"
              />
            </div>
            {(() => {
              const cats = Array.from(new Set(products.map((p) => p.category).filter((c): c is string => !!c))).sort();
              if (cats.length === 0) return null;
              return (
                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveCategory(null)}
                    className={
                      "rounded-full px-3.5 py-1.5 text-sm font-medium touch-manipulation select-none transition active:scale-[0.97] " +
                      (activeCategory === null
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80")
                    }
                  >
                    {thaiMode ? "ทั้งหมด" : "All"}
                  </button>
                  {cats.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setActiveCategory(cat)}
                      className={
                        "rounded-full px-3.5 py-1.5 text-sm font-medium touch-manipulation select-none transition active:scale-[0.97] " +
                        (activeCategory === cat
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-muted/80")
                      }
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              );
            })()}
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {filteredProducts.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">{t.inv_no_match}</p>
            ) : (
              // Grid sized for an iPad in landscape (1024px outer ≈ 660px content
              // after sidebar + padding): three columns gives ~200px cards which
              // accommodates a thumb. Phones get 2; bigger desktops get 4.
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {filteredProducts.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => addToCart(p)}
                    className="flex min-h-[110px] flex-col items-start gap-1 rounded-lg border bg-card p-4 text-left touch-manipulation select-none transition active:scale-[0.98] active:bg-muted/70 hover:border-primary hover:shadow-sm"
                  >
                    <span className="text-[11px] text-muted-foreground">{p.category ?? "—"}</span>
                    <span className="font-medium leading-tight text-[15px]">{p.name}</span>
                    <span className="mt-auto text-base font-semibold text-primary">
                      {formatMoney(p.priceCents, p.currency)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{t.inv_on_hand} {p.stockQty}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---- Cart + checkout ---- */}
        <Card className="flex flex-col overflow-hidden">
          <CardHeader className="shrink-0 flex-row items-center justify-between pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShoppingCart className="h-4 w-4" /> {t.pos_cart_title} ({cart.length})
            </CardTitle>
            {cart.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearCart}>{thaiMode ? "ล้าง" : "Clear"}</Button>
            )}
          </CardHeader>
          <CardContent className="flex flex-1 flex-col overflow-hidden p-0">
            <div className="flex-1 overflow-auto px-6">
              {cart.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{t.pos_cart_empty}</p>
              ) : (
                <ul className="space-y-3">
                  {cart.map((l) => (
                    <li key={l.productId} className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-[15px] font-medium leading-tight">{l.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatMoney(l.unitPriceCents, currency)} × {l.qty} ={" "}
                          <span className="font-semibold text-foreground">
                            {formatMoney(l.unitPriceCents * l.qty, currency)}
                          </span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-10 w-10 touch-manipulation active:scale-[0.97]"
                          onClick={() => changeQty(l.productId, -1)}
                          aria-label="Decrease quantity"
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <span className="min-w-[1.75rem] text-center text-base font-semibold tabular-nums">{l.qty}</span>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-10 w-10 touch-manipulation active:scale-[0.97]"
                          onClick={() => changeQty(l.productId, 1)}
                          aria-label="Increase quantity"
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-10 w-10 text-destructive touch-manipulation active:scale-[0.97]"
                          onClick={() => removeLine(l.productId)}
                          aria-label="Remove line"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Separator />

            {/* 🍴 Restaurant mode: order type + table + tip (gated by Pro flag) */}
            {restaurantMode && (
              <div className="space-y-2 border-b px-6 py-3 bg-muted/20">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {thaiMode ? "ประเภทออเดอร์" : "Order type"}
                  </span>
                  {(["dine_in", "takeout", "delivery"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setOrderType(orderType === t ? "" : t)}
                      className={
                        "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition " +
                        (orderType === t
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background hover:bg-muted")
                      }
                    >
                      {t === "dine_in" && (thaiMode ? "ทานที่ร้าน" : "Dine-in")}
                      {t === "takeout" && (thaiMode ? "กลับบ้าน" : "Takeout")}
                      {t === "delivery" && (thaiMode ? "จัดส่ง" : "Delivery")}
                    </button>
                  ))}
                </div>
                {orderType === "dine_in" && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground shrink-0 w-20">
                      {thaiMode ? "เลขโต๊ะ" : "Table"}
                    </label>
                    <Input
                      value={tableNumber}
                      onChange={(e) => setTableNumber(e.target.value.slice(0, 16))}
                      placeholder={thaiMode ? "เช่น T5" : "e.g. T5"}
                      className="h-8 w-28 text-sm"
                    />
                    {cart.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSplitOpen(true)}
                        className="ml-auto text-xs text-primary hover:underline"
                      >
                        {thaiMode ? "แยกบิล" : "Split bill"}
                      </button>
                    )}
                  </div>
                )}
                {cart.length > 0 && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground shrink-0 w-20">
                      {thaiMode ? "ทิป" : "Tip"}
                    </label>
                    {[5, 10, 15].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => setTipCents(Math.round(totalPreview * pct / 100))}
                        className="rounded border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-muted"
                      >
                        {pct}%
                      </button>
                    ))}
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      value={tipCents || ""}
                      onChange={(e) => setTipCents(Math.max(0, parseInt(e.target.value) || 0))}
                      placeholder={thaiMode ? "สตางค์" : "cents"}
                      className="h-8 w-24 text-sm tabular-nums"
                    />
                    {tipCents > 0 && (
                      <button
                        type="button"
                        onClick={() => setTipCents(0)}
                        className="text-xs text-muted-foreground hover:text-destructive"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Cart-level discount input */}
            {cart.length > 0 && (
              <div className="flex items-center gap-2 px-6 pt-3">
                <label className="text-xs text-muted-foreground shrink-0">
                  {thaiMode ? "ส่วนลด (สตางค์)" : "Discount (cents)"}
                </label>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={subtotalPreview}
                  value={cartDiscountCents || ""}
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(subtotalPreview, parseInt(e.target.value) || 0));
                    setCartDiscountCents(v);
                  }}
                  placeholder="0"
                  className="h-8 w-28 text-sm tabular-nums"
                />
                {cartDiscountCents > 0 && (
                  <span className="text-xs text-emerald-600">-{formatMoney(cartDiscountCents, currency)}</span>
                )}
              </div>
            )}

            <div className="space-y-1 px-6 pt-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t.subtotal}</span>
                <span>{formatMoney(subtotalPreview, currency)}</span>
              </div>
              {cartDiscountCents > 0 && (
                <div className="flex justify-between text-emerald-600">
                  <span className="text-muted-foreground">{thaiMode ? "ส่วนลด" : "Discount"}</span>
                  <span>-{formatMoney(cartDiscountCents, currency)}</span>
                </div>
              )}
              {vatRate > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {thaiMode ? "VAT" : "Tax"} {(vatRate * 100).toFixed(2)}% {thaiMode ? "(ประมาณ)" : "(preview)"}
                  </span>
                  <span>{formatMoney(vatPreview, currency)}</span>
                </div>
              )}
              <div className={`flex justify-between ${tipCents > 0 ? "text-sm" : "text-lg font-semibold"}`}>
                <span className={tipCents > 0 ? "text-muted-foreground" : ""}>{t.total}</span>
                <span className="tabular-nums">{formatMoney(totalPreview, currency)}</span>
              </div>
              {tipCents > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{thaiMode ? "ทิป" : "Tip"}</span>
                    <span className="tabular-nums">{formatMoney(tipCents, currency)}</span>
                  </div>
                  <div className="flex justify-between text-lg font-semibold border-t pt-1 mt-1">
                    <span>{thaiMode ? "รวมที่ต้องชำระ" : "Total due"}</span>
                    <span className="tabular-nums">{formatMoney(totalPreview + tipCents, currency)}</span>
                  </div>
                </>
              )}
            </div>

            {/* 🇹🇭 Buyer block. In Thai mode a TIN upgrades the doc to a
                Full Tax Invoice (TX). In generic mode it's just a reference. */}
            <div className="border-t px-6 pt-3">
              <button
                className="flex w-full items-center gap-2 py-1.5 text-sm text-muted-foreground touch-manipulation hover:text-foreground"
                onClick={() => setBuyerOpen((v) => !v)}
              >
                <User className="h-4 w-4" />{" "}
                {buyerOpen ? (thaiMode ? "ซ่อน" : "Hide") : (thaiMode ? "เพิ่มผู้ซื้อ" : "Add customer")}
                {thaiMode ? " (กรอก TIN = ใบกำกับเต็มรูป)" : ""}
              </button>
              {buyerOpen && (
                <div className="mt-2 space-y-2">
                  <CustomerAutocomplete
                    onPick={(c) => {
                      setBuyerName(c.name ?? "");
                      setBuyerTin(c.tin ?? "");
                      setBuyerBranch(c.branchCode ?? "");
                      const addr = (c.address as Record<string, string> | null)?.line ?? "";
                      setBuyerAddress(addr);
                    }}
                    thaiMode={thaiMode}
                  />
                  <Input
                    placeholder={t.pos_buyer_name}
                    value={buyerName}
                    onChange={(e) => setBuyerName(e.target.value)}
                    className="h-11 text-base"
                  />
                  {thaiMode && (
                    <div className={`grid gap-2 ${multiBranch ? "grid-cols-3" : "grid-cols-1"}`}>
                      <Input
                        placeholder={t.pos_buyer_tin}
                        value={buyerTin}
                        onChange={(e) => setBuyerTin(e.target.value.replace(/\D/g, "").slice(0, 13))}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        className={`${multiBranch ? "col-span-2" : ""} h-11 text-base tabular-nums`}
                      />
                      {multiBranch && (
                        <Input
                          placeholder={t.pos_buyer_branch}
                          value={buyerBranch}
                          onChange={(e) => setBuyerBranch(e.target.value.replace(/\D/g, "").slice(0, 5))}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          className="h-11 text-base tabular-nums"
                        />
                      )}
                    </div>
                  )}
                  <Input
                    placeholder={t.pos_buyer_address}
                    value={buyerAddress}
                    onChange={(e) => setBuyerAddress(e.target.value)}
                    className="h-11 text-base"
                  />
                </div>
              )}
            </div>

            <div className="space-y-2 px-6 py-4">
              <Input
                type="number"
                inputMode="decimal"
                pattern="[0-9]*"
                placeholder={thaiMode ? "เงินที่รับมา (สตางค์)" : "Cash tendered (cents)"}
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                disabled={cart.length === 0}
                className="h-12 text-lg tabular-nums"
              />
              {tendered && (
                <p className="text-sm text-muted-foreground tabular-nums">
                  {t.pos_change_due}{" "}
                  <span
                    className={
                      "font-semibold " + (change < 0 ? "text-rose-600" : "text-foreground")
                    }
                  >
                    {formatMoney(change, currency)}
                  </span>
                </p>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className={`grid gap-2 ${thaiMode ? "grid-cols-3" : "grid-cols-2"}`}>
                <Button
                  onClick={() => checkout("cash")}
                  disabled={processing || cart.length === 0}
                  className="h-14 text-base font-semibold touch-manipulation active:scale-[0.98]"
                >
                  {processing ? <Loader2 className="h-5 w-5 animate-spin" /> : t.pos_pay_cash}
                </Button>
                <Button
                  onClick={() => checkout("card")}
                  disabled={processing || cart.length === 0}
                  variant="secondary"
                  className="h-14 text-base font-semibold touch-manipulation active:scale-[0.98]"
                >
                  {t.pos_pay_card}
                </Button>
                {thaiMode && (
                  <Button
                    onClick={() => checkout("promptpay")}
                    disabled={processing || cart.length === 0}
                    variant="outline"
                    className="h-14 text-base font-semibold touch-manipulation active:scale-[0.98]"
                  >
                    <QrCode className="h-5 w-5" /> {t.pos_pay_qr}
                  </Button>
                )}
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  onClick={() => setHoldOpen(true)}
                  disabled={cart.length === 0}
                  variant="outline"
                  className="h-11 flex-1 touch-manipulation active:scale-[0.98]"
                >
                  <Pause className="h-4 w-4" /> {thaiMode ? "พักออเดอร์" : "Hold"}
                </Button>
                <Button
                  onClick={() => setRecallOpen(true)}
                  variant="outline"
                  className="h-11 flex-1 touch-manipulation active:scale-[0.98]"
                >
                  <Play className="h-4 w-4" /> {thaiMode ? "เรียกคืน" : "Recall"}
                  {heldCount > 0 && (
                    <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700">
                      {heldCount}
                    </span>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---- Recent orders ---- */}
      {recentOrders.length > 0 && (
        <Card className="shrink-0">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Receipt className="h-4 w-4" /> {thaiMode ? "ออเดอร์ล่าสุดในรอบนี้" : "Recent orders in this session"}
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-auto pb-3">
            <div className="flex gap-2">
              {recentOrders.slice(0, 8).map((o) => (
                <div
                  key={o.id}
                  data-order-id={o.id}
                  className={`min-w-[200px] rounded-md border bg-muted/30 p-3 text-xs ${
                    o.id === focusOrderId ? "ring-2 ring-primary ring-offset-1" : ""
                  }`}
                >
                  <p className="text-sm font-semibold tabular-nums">{formatMoney(o.totalCents, o.currency)}</p>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {o.documentType} · {o.documentNumber ?? "—"}
                  </p>
                  <p className="text-muted-foreground">{o.paymentMethod} · {t.items_count(o.orderLines.length)} · {o.status}</p>
                  <div className="mt-2 flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 px-2 text-xs touch-manipulation"
                      onClick={() =>
                        openAuthed(`/api/pos/receipts/${o.id}.html`).catch((e) =>
                          alert(`Receipt failed: ${e.message}`),
                        )
                      }
                    >
                      <Receipt className="h-3.5 w-3.5" /> {t.pos_print_receipt}
                    </Button>
                    {o.status === "paid" && o.documentType !== "CN" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 px-2 text-xs touch-manipulation"
                        onClick={() => setRefundTarget(o)}
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> {t.pos_refund}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 px-2 text-xs touch-manipulation"
                      onClick={() => setEmailTarget(o)}
                    >
                      <Mail className="h-3.5 w-3.5" /> {thaiMode ? "อีเมล" : "Email"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---- PromptPay QR modal ---- */}
      {qrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setQrModal(null)}>
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <CardHeader>
              <CardTitle>{thaiMode ? "สแกน QR เพื่อชำระเงินผ่านพร้อมเพย์" : "Scan to pay via PromptPay"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-center">
              <div className="rounded border bg-muted/30 p-2 text-xs font-mono break-all">
                {qrModal.promptpayQr}
              </div>
              <p className="text-xs text-muted-foreground">
                {thaiMode
                  ? "ข้อมูล EMVCo ด้านบน — เครื่องสร้างภาพ QR จะแปลงเป็นโค้ดสแกนได้บน iPad/เครื่องพิมพ์"
                  : "EMVCo payload shown above. A real QR rasteriser will turn this into a scannable code on the iPad/printer."}
              </p>
              <p className="text-sm font-semibold">
                {formatMoney(qrModal.totalCents, qrModal.currency)} — {qrModal.documentType} {qrModal.documentNumber}
              </p>
              <div className="flex gap-2">
                <Button
                  className="h-11 flex-1 touch-manipulation"
                  variant="outline"
                  onClick={() =>
                    openAuthed(`/api/pos/receipts/${qrModal.id}.html`).catch((e) =>
                      alert(`Receipt failed: ${e.message}`),
                    )
                  }
                >
                  {thaiMode ? "ดูใบเสร็จ" : "Preview receipt"}
                </Button>
                <Button
                  className="h-11 flex-1 touch-manipulation"
                  onClick={() => setQrModal(null)}
                >
                  {thaiMode ? "เสร็จสิ้น" : "Done"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---- Refund modal ---- */}
      {refundTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setRefundTarget(null)}>
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <CardHeader>
              <CardTitle>{t.pos_refund} {refundTarget.documentNumber}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {thaiMode
                  ? "การคืนเงินเต็มจำนวนจะออกใบลดหนี้ (CN) ผูกกับออเดอร์นี้"
                  : "Full refund issues a credit entry linked to this order."}{" "}
                {thaiMode ? "ยอด:" : "Amount:"} <b>{formatMoney(refundTarget.totalCents, refundTarget.currency)}</b>
              </p>
              <Input
                placeholder={thaiMode ? "เหตุผล (จำเป็นตาม ม.86/10)" : "Reason (required)"}
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                className="h-11 text-base"
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button
                  className="h-11 flex-1 touch-manipulation"
                  variant="outline"
                  onClick={() => setRefundTarget(null)}
                >
                  {t.cancel}
                </Button>
                <Button
                  className="h-11 flex-1 touch-manipulation"
                  onClick={doRefund}
                  disabled={processing || refundReason.length < 3}
                >
                  {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : t.pos_refund_confirm}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---- Email-receipt modal ---- */}
      {emailTarget && (
        <EmailReceiptModal
          order={emailTarget}
          thaiMode={thaiMode}
          onClose={() => setEmailTarget(null)}
        />
      )}

      {/* ---- Hold modal ---- */}
      {holdOpen && session && (
        <HoldCartModal
          thaiMode={thaiMode}
          onClose={() => setHoldOpen(false)}
          onHeld={() => {
            setHoldOpen(false);
            setCart([]);
            setBuyerName(""); setBuyerTin(""); setBuyerBranch(""); setBuyerAddress("");
            setHeldCount((n) => n + 1);
            setToast(thaiMode ? "พักออเดอร์เรียบร้อย" : "Cart held");
            setTimeout(() => setToast(null), 2500);
          }}
          sessionId={session.id}
          cart={cart}
          buyer={buyerName || buyerTin ? { name: buyerName, tin: buyerTin, branch: buyerBranch, address: buyerAddress } : null}
        />
      )}

      {/* ---- Recall modal ---- */}
      {recallOpen && session && (
        <RecallCartModal
          thaiMode={thaiMode}
          sessionId={session.id}
          onClose={() => setRecallOpen(false)}
          onRecalled={(held: HeldCart) => {
            setRecallOpen(false);
            const lines: CartLine[] = (held.cartLines as Array<{ productId: string; name: string; qty: number; unitPriceCents: number; vatCategory?: CartLine["vatCategory"] }>).map((l) => ({
              lineKey: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2),
              productId: l.productId,
              name: l.name,
              qty: l.qty,
              unitPriceCents: l.unitPriceCents,
              vatCategory: l.vatCategory,
            }));
            setCart(lines);
            const buyer = (held.buyer ?? null) as { name?: string; tin?: string; branch?: string; address?: string } | null;
            if (buyer) {
              setBuyerOpen(true);
              setBuyerName(buyer.name ?? "");
              setBuyerTin(buyer.tin ?? "");
              setBuyerBranch(buyer.branch ?? "");
              setBuyerAddress(buyer.address ?? "");
            }
            setHeldCount((n) => Math.max(0, n - 1));
            setToast(thaiMode ? `เรียกคืน "${held.label}"` : `Recalled "${held.label}"`);
            setTimeout(() => setToast(null), 2500);
          }}
        />
      )}

      {/* ---- Modifier picker modal ---- */}
      {modPicker && (
        <ModifierPickerModal
          product={modPicker}
          thaiMode={thaiMode}
          onClose={() => setModPicker(null)}
          onAddToCart={(modifiers) => {
            pushCartLine(modPicker, modifiers);
            setModPicker(null);
          }}
        />
      )}

      {/* ---- Split bill modal ---- */}
      {splitOpen && session && (
        <SplitBillModal
          sessionId={session.id}
          cart={cart}
          currency={currency}
          totalPreview={totalPreview}
          orderType={orderType || undefined}
          tableNumber={tableNumber || undefined}
          thaiMode={thaiMode}
          onClose={() => setSplitOpen(false)}
          onComplete={(refreshOrders) => {
            setSplitOpen(false);
            clearCart();
            setCartDiscountCents(0);
            setTipCents(0);
            setTendered("");
            setTableNumber("");
            setToast(thaiMode ? "แยกบิลเสร็จสิ้น" : "Split bill complete");
            setTimeout(() => setToast(null), 3000);
            refreshOrders();
          }}
          refreshOrders={async () => {
            if (!session) return;
            const orders = await api<OrderRow[]>(`/api/pos/orders?sessionId=${session.id}&limit=10`);
            setRecentOrders(orders);
          }}
        />
      )}

      {/* ---- Toast ---- */}
      {toast && (
        <div className="pointer-events-none fixed bottom-6 right-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Customer autocomplete ──────────────────────────────────────────────────
interface PartnerHit {
  id: string;
  name: string;
  tin: string | null;
  branchCode: string | null;
  email: string | null;
  phone: string | null;
  address: Record<string, string> | null;
}

function CustomerAutocomplete({
  onPick,
  thaiMode,
}: {
  onPick: (p: PartnerHit) => void;
  thaiMode: boolean;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PartnerHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      setLoading(true);
      api<PartnerHit[]>(
        `/api/purchasing/partners?role=customer&search=${encodeURIComponent(q)}`,
      )
        .then((rows) => setHits(rows.slice(0, 8)))
        .catch(() => setHits([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <div className="relative">
      <Input
        placeholder={
          thaiMode
            ? "ค้นหาลูกค้าเดิม (ชื่อหรือเลขผู้เสียภาษี)"
            : "Find existing customer (name or TIN)"
        }
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (q.length >= 2 || loading) && (
        <div className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-background shadow-lg">
          {loading && hits.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">…</div>
          ) : hits.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">
              {thaiMode ? "ไม่พบลูกค้า" : "No matches"}
            </div>
          ) : (
            hits.map((h) => (
              <button
                key={h.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(h);
                  setQ("");
                  setOpen(false);
                }}
                className="block w-full border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-muted"
              >
                <div className="font-medium">{h.name}</div>
                <div className="text-xs text-muted-foreground">
                  {h.tin ? formatTin13(h.tin) : (thaiMode ? "ไม่มี TIN" : "no TIN")}
                  {h.email ? ` • ${h.email}` : ""}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function formatTin13(tin: string): string {
  const d = tin.replace(/\D/g, "");
  if (d.length !== 13) return tin;
  return `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
}

// ─── Email-receipt modal ───────────────────────────────────────────────────
function EmailReceiptModal({
  order,
  thaiMode,
  onClose,
}: {
  order: OrderRow;
  thaiMode: boolean;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ mode: string; messageId?: string } | null>(null);

  const send = async () => {
    if (!/.+@.+\..+/.test(email)) {
      setError(thaiMode ? "อีเมลไม่ถูกต้อง" : "Invalid email");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await api<{ ok: true; mode: string; messageId?: string }>(
        `/api/pos/receipts/${order.id}/email`,
        {
          method: "POST",
          body: JSON.stringify({ to: email }),
        },
      );
      setDone(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle className="text-base">
            {thaiMode ? "ส่งใบเสร็จทางอีเมล" : "Email receipt"} {order.documentNumber}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!done ? (
            <>
              <Input
                type="email"
                inputMode="email"
                autoCapitalize="off"
                autoComplete="email"
                placeholder={thaiMode ? "อีเมลผู้รับ" : "Recipient email"}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                autoFocus
                className="h-11 text-base"
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button className="h-11 flex-1 touch-manipulation" variant="outline" onClick={onClose}>
                  {thaiMode ? "ยกเลิก" : "Cancel"}
                </Button>
                <Button className="h-11 flex-1 touch-manipulation" onClick={send} disabled={sending || !email}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Mail className="h-4 w-4" /> {thaiMode ? "ส่ง" : "Send"}</>}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm">
                {thaiMode ? "ส่งสำเร็จไปที่" : "Sent to"} <b>{email}</b>
              </p>
              {done.mode === "json-transport" && (
                <p className="text-xs text-amber-600">
                  {thaiMode
                    ? "โหมดทดสอบ (ไม่ได้ตั้งค่า SMTP) — เนื้อหาเขียนลงล็อก"
                    : "Dev mode (SMTP not configured) — payload written to log"}
                </p>
              )}
              <Button className="w-full" onClick={onClose}>
                {thaiMode ? "เสร็จสิ้น" : "Done"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Hold + Recall ──────────────────────────────────────────────────────────
interface HeldCart {
  id: string;
  sessionId: string | null;
  label: string;
  cartLines: unknown;
  buyer: unknown;
  cartDiscountCents: number;
  createdAt: string;
}

function HoldCartModal({
  thaiMode,
  onClose,
  onHeld,
  sessionId,
  cart,
  buyer,
}: {
  thaiMode: boolean;
  onClose: () => void;
  onHeld: () => void;
  sessionId: string;
  cart: CartLine[];
  buyer: { name?: string; tin?: string; branch?: string; address?: string } | null;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!label.trim()) {
      setErr(thaiMode ? "ใส่ชื่ออ้างอิง เช่น โต๊ะ 5" : "Enter a label, e.g. Table 5");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/pos/held-carts`, {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          label,
          lines: cart.map((c) => ({
            productId: c.productId,
            name: c.name,
            qty: c.qty,
            unitPriceCents: c.unitPriceCents,
            vatCategory: c.vatCategory,
          })),
          buyer,
        }),
      });
      onHeld();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle className="text-base">{thaiMode ? "พักออเดอร์" : "Hold cart"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {thaiMode
              ? "บันทึกตะกร้านี้ไว้เพื่อเรียกคืนภายหลัง — จะยังไม่ออกใบเสร็จและจะไม่ตัดสต๊อก"
              : "Save this cart to recall later. No receipt is printed and stock is not deducted."}
          </p>
          <Input
            placeholder={thaiMode ? "ชื่ออ้างอิง เช่น โต๊ะ 5 / ลูกค้าชื่อ A" : "Label, e.g. Table 5 / Customer A"}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoFocus
            className="h-11 text-base"
          />
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 flex-1 touch-manipulation" onClick={onClose}>
              {thaiMode ? "ยกเลิก" : "Cancel"}
            </Button>
            <Button className="h-11 flex-1 touch-manipulation" onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Pause className="h-4 w-4" /> {thaiMode ? "พักไว้" : "Hold"}</>}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RecallCartModal({
  thaiMode,
  sessionId,
  onClose,
  onRecalled,
}: {
  thaiMode: boolean;
  sessionId: string;
  onClose: () => void;
  onRecalled: (held: HeldCart) => void;
}) {
  const [held, setHeld] = useState<HeldCart[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<HeldCart[]>(`/api/pos/held-carts?sessionId=${sessionId}`)
      .then((rows) => setHeld(rows))
      .catch(() => setHeld([]))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const recall = async (id: string) => {
    const result = await api<HeldCart>(`/api/pos/held-carts/${id}/recall`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
    onRecalled(result);
  };

  const cancel = async (id: string) => {
    await api(`/api/pos/held-carts/${id}`, { method: "DELETE" });
    setHeld((rows) => rows.filter((r) => r.id !== id));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle className="text-base">{thaiMode ? "เรียกคืนออเดอร์ที่พักไว้" : "Recall held cart"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">…</p>
          ) : held.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {thaiMode ? "ไม่มีออเดอร์พักไว้ในรอบนี้" : "No held carts in this session"}
            </p>
          ) : (
            held.map((h) => {
              const lines = (h.cartLines as Array<{ qty: number; unitPriceCents: number }>) ?? [];
              const total = lines.reduce((s, l) => s + l.qty * l.unitPriceCents, 0);
              return (
                <div key={h.id} className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{h.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {lines.length} {thaiMode ? "รายการ" : "items"} · {new Intl.NumberFormat().format(total / 100)}
                      {" · "}
                      {new Date(h.createdAt).toLocaleTimeString()}
                    </p>
                  </div>
                  <Button size="sm" className="h-10 touch-manipulation" onClick={() => recall(h.id)}>
                    <Play className="h-4 w-4" /> {thaiMode ? "เรียกคืน" : "Recall"}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-10 w-10 touch-manipulation"
                    onClick={() => cancel(h.id)}
                    aria-label={thaiMode ? "ลบ" : "Discard"}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              );
            })
          )}
          <Button variant="outline" className="h-11 w-full touch-manipulation" onClick={onClose}>
            {thaiMode ? "ปิด" : "Close"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Modifier picker modal ────────────────────────────────────────────────
// Opens when a customer taps a product with modifier groups (e.g., size, toppings).
// User selects one option per group (if !multi) or multiple (if multi).
// Validation: required groups must have >= 1 selection.
// On submit: maps state to ChosenModifier[] and calls onAddToCart with the snapshot.
function ModifierPickerModal({
  product,
  thaiMode,
  onClose,
  onAddToCart,
}: {
  product: Product;
  thaiMode: boolean;
  onClose: () => void;
  onAddToCart: (modifiers: ChosenModifier[]) => void;
}) {
  const t = useT();
  // chosenModifiers: groupName -> array of chosen option names (even if single-select, we store as array for uniformity)
  const [chosenModifiers, setChosenModifiers] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  // Validate that all required groups have at least one selection
  const isValid = (product.modifierGroups ?? []).every((g) => {
    if (!g.required) return true;
    const chosen = chosenModifiers[g.name] ?? [];
    return chosen.length > 0;
  });

  const handleSelect = (groupName: string, optionName: string, isMulti: boolean) => {
    setChosenModifiers((prev) => {
      const group = prev[groupName] ?? [];
      if (isMulti) {
        // Multi-select: toggle the option
        const idx = group.indexOf(optionName);
        if (idx >= 0) {
          return { ...prev, [groupName]: group.filter((_, i) => i !== idx) };
        }
        return { ...prev, [groupName]: [...group, optionName] };
      } else {
        // Single-select: replace with this option
        return { ...prev, [groupName]: [optionName] };
      }
    });
    setError(null);
  };

  const submit = () => {
    if (!isValid) {
      setError(thaiMode ? "เลือกตัวเลือกที่จำเป็น" : "Select required options");
      return;
    }

    // Map chosenModifiers state -> ChosenModifier[] by looking up each option's priceDeltaCents
    const snapshot: ChosenModifier[] = [];
    (product.modifierGroups ?? []).forEach((g) => {
      const chosen = chosenModifiers[g.name] ?? [];
      chosen.forEach((optionName) => {
        const opt = g.options.find((o) => o.name === optionName);
        if (opt) {
          snapshot.push({
            groupName: g.name,
            name: optionName,
            priceDeltaCents: opt.priceDeltaCents,
          });
        }
      });
    });

    onAddToCart(snapshot);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-md overflow-y-auto max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle className="text-base">{product.name}</CardTitle>
          <CardDescription>{thaiMode ? "เลือกตัวเลือก" : "Choose options"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(product.modifierGroups ?? []).map((group) => {
            const chosen = chosenModifiers[group.name] ?? [];
            const isMulti = group.multi;
            const isRequired = group.required;

            return (
              <div key={group.id} className="space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">{group.name}</label>
                  {isRequired && <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">{thaiMode ? "จำเป็น" : "Required"}</span>}
                  {isMulti && <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">{thaiMode ? "เลือกได้หลายรายการ" : "Multi"}</span>}
                </div>

                {/* Option buttons/checkboxes */}
                <div className="flex flex-wrap gap-2">
                  {group.options.map((opt) => {
                    const isSelected = chosen.includes(opt.name);
                    const priceLabel =
                      opt.priceDeltaCents === 0
                        ? ""
                        : opt.priceDeltaCents > 0
                          ? `+${formatMoney(opt.priceDeltaCents, "THB")}`
                          : formatMoney(opt.priceDeltaCents, "THB");

                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => handleSelect(group.name, opt.name, isMulti)}
                        className={`px-3 py-2 text-sm rounded-md border transition ${
                          isSelected
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-muted border-muted-foreground/50 text-foreground hover:bg-muted/80"
                        }`}
                      >
                        {opt.name} {priceLabel && <span className="text-xs opacity-75 ml-1">{priceLabel}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="h-11 flex-1 touch-manipulation" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button className="h-11 flex-1 touch-manipulation" onClick={submit} disabled={!isValid}>
              {t.pos_pick_done}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Split bill modal ─────────────────────────────────────────────────────
// Splits the current cart into N equal portions. Each split becomes its own
// order with `splitParentId` linking them, so reports can group "what one
// table actually paid". Each split keeps the same items at proportional
// price; the last split absorbs any rounding remainder so the sum exactly
// equals the parent total.
function SplitBillModal({
  sessionId,
  cart,
  currency,
  totalPreview,
  orderType,
  tableNumber,
  thaiMode,
  onClose,
  onComplete,
  refreshOrders,
}: {
  sessionId: string;
  cart: CartLine[];
  currency: string;
  totalPreview: number;
  orderType?: string;
  tableNumber?: string;
  thaiMode: boolean;
  onClose: () => void;
  onComplete: (refresh: () => Promise<void>) => void;
  refreshOrders: () => Promise<void>;
}) {
  const [n, setN] = useState(2);
  const [splitMethods, setSplitMethods] = useState<Array<"cash" | "card" | "promptpay">>(
    ["cash", "cash"],
  );
  const [paidIndex, setPaidIndex] = useState(0);
  const [parentId] = useState(() => crypto.randomUUID());
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CreateOrderResponse[]>([]);

  const perSplit = Math.floor(totalPreview / n);
  const remainder = totalPreview - perSplit * n;

  // Build the line set for split #i (0-indexed). Last split gets the remainder.
  const linesForSplit = (i: number): CartLine[] => {
    const fraction = i === n - 1 ? perSplit + remainder : perSplit;
    const totalLineQty = cart.reduce((s, l) => s + l.qty * l.unitPriceCents, 0);
    if (totalLineQty === 0) return [];
    return cart.map((line) => ({
      ...line,
      // Scale each line proportionally to this split's share.
      unitPriceCents: Math.max(0, Math.round((line.unitPriceCents * fraction) / totalLineQty)),
    }));
  };

  const updateMethod = (i: number, m: "cash" | "card" | "promptpay") => {
    setSplitMethods((prev) => {
      const next = [...prev];
      while (next.length < n) next.push("cash");
      next[i] = m;
      return next;
    });
  };

  // When N changes, resize the methods array.
  useEffect(() => {
    setSplitMethods((prev) => {
      const arr = prev.slice(0, n);
      while (arr.length < n) arr.push("cash");
      return arr;
    });
  }, [n]);

  const payNext = async () => {
    if (paidIndex >= n) return;
    setProcessing(true);
    setError(null);
    try {
      const i = paidIndex;
      const fraction = i === n - 1 ? perSplit + remainder : perSplit;
      const method = splitMethods[i] ?? "cash";
      const body: Record<string, unknown> = {
        offlineId: crypto.randomUUID(),
        sessionId,
        lines: linesForSplit(i),
        currency,
        splitParentId: parentId,
        ...(orderType ? { orderType } : {}),
        ...(tableNumber ? { tableNumber } : {}),
        payment: {
          method,
          amountCents: fraction,
          ...(method === "cash" ? { tenderedCents: fraction, changeCents: 0 } : {}),
          ...(method === "card" ? { cardLast4: "4242" } : {}),
        },
      };
      const resp = await api<CreateOrderResponse>(`/api/pos/orders`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setResults((r) => [...r, resp]);
      setPaidIndex(i + 1);
      if (i + 1 >= n) {
        await refreshOrders();
        // All splits paid — callback to clear and close.
        onComplete(refreshOrders);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle>{thaiMode ? "แยกบิล (Split bill)" : "Split bill"}</CardTitle>
          <CardDescription>
            {thaiMode
              ? `แบ่งบิลเท่ากัน — แต่ละคนจ่าย ${formatMoney(perSplit, currency)}`
              : `Even split — each pays ${formatMoney(perSplit, currency)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* N selector */}
          <div className="flex items-center gap-2">
            <label className="text-sm shrink-0 w-24">{thaiMode ? "จำนวนคน" : "# of splits"}</label>
            <div className="flex items-center gap-1">
              {[2, 3, 4, 5, 6].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => paidIndex === 0 && setN(k)}
                  disabled={paidIndex > 0}
                  className={
                    "h-9 w-9 rounded-md border text-sm font-medium transition disabled:opacity-50 " +
                    (n === k ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted")
                  }
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          {/* Per-split payment list */}
          <div className="space-y-1.5">
            {Array.from({ length: n }).map((_, i) => {
              const fraction = i === n - 1 ? perSplit + remainder : perSplit;
              const isPaid = i < paidIndex;
              const isCurrent = i === paidIndex;
              return (
                <div
                  key={i}
                  className={
                    "flex items-center gap-2 rounded-md border p-2 text-sm " +
                    (isPaid ? "bg-emerald-50 dark:bg-emerald-950/20" : isCurrent ? "ring-2 ring-primary" : "")
                  }
                >
                  <span className="w-8 font-medium text-muted-foreground">#{i + 1}</span>
                  <span className="tabular-nums w-28">{formatMoney(fraction, currency)}</span>
                  {isPaid ? (
                    <span className="ml-auto text-xs text-emerald-700 font-medium">
                      {thaiMode ? "ชำระแล้ว" : "Paid"} ✓
                    </span>
                  ) : (
                    <select
                      value={splitMethods[i] ?? "cash"}
                      onChange={(e) => updateMethod(i, e.target.value as "cash" | "card" | "promptpay")}
                      disabled={!isCurrent || processing}
                      className="h-8 rounded-md border bg-background px-2 text-xs ml-auto"
                    >
                      <option value="cash">{thaiMode ? "เงินสด" : "Cash"}</option>
                      <option value="card">{thaiMode ? "บัตร" : "Card"}</option>
                      <option value="promptpay">PromptPay</option>
                    </select>
                  )}
                </div>
              );
            })}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={processing} className="flex-1">
              {thaiMode ? "ยกเลิก" : "Cancel"}
            </Button>
            {paidIndex < n && (
              <Button onClick={payNext} disabled={processing || cart.length === 0} className="flex-1">
                {processing ? "..." : thaiMode
                  ? `รับเงินคนที่ ${paidIndex + 1}`
                  : `Charge split ${paidIndex + 1}/${n}`}
              </Button>
            )}
          </div>

          {results.length > 0 && (
            <div className="border-t pt-2 space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {thaiMode ? "ใบเสร็จที่ออกแล้ว" : "Receipts issued"}
              </p>
              {results.map((r) => (
                <div key={r.id} className="text-xs flex justify-between items-center">
                  <span>{r.documentNumber}</span>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      openAuthed(`/api/pos/receipts/${r.id}.html`);
                    }}
                    className="text-primary hover:underline"
                  >
                    {thaiMode ? "พิมพ์" : "Print"}
                  </a>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
