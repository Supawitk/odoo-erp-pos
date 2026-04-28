import { useEffect, useState } from 'react';
import { FlatList, View, Pressable, ScrollView } from 'react-native';
import { Button, Card, Divider, IconButton, Searchbar, Text, TextInput, useTheme } from 'react-native-paper';
import { v7 as uuidv7 } from 'uuid';
import { api, ApiError } from '../api/client';
import { usePos } from '../state/pos.store';
import { collectCardPayment } from '../payments/stripe-terminal';
import { printReceipt } from '../printing/thermal-printer';
import { enqueue, drain } from '../offline/sync.service';
import { useOrgSettings, formatMoney } from '../hooks/useOrgSettings';

type Product = {
  id: string;
  name: string;
  category: string | null;
  priceCents: number;
  currency: string;
  stockQty: number;
};

type CreateOrderResponse = {
  id: string;
  documentType: 'RE' | 'ABB' | 'TX' | 'CN';
  documentNumber: string;
  totalCents: number;
  taxCents: number;
  currency: string;
  promptpayQr: string | null;
};

export default function PosScreen({ navigation }: { navigation: any }) {
  const theme = useTheme();
  const { settings } = useOrgSettings();
  const thaiMode = settings?.countryMode === 'TH';
  const currency = settings?.currency ?? 'THB';
  const locale = settings?.locale ?? 'th-TH';
  const vatRate = settings?.vatRegistered ? settings?.vatRate ?? 0.07 : 0;
  const fmt = (cents: number) => formatMoney(cents, currency, locale);

  const { session, cart, buyerTin, add, inc, remove, clear, setBuyerTin, setSession } = usePos();
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<CreateOrderResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await api<Product[]>('/api/products?limit=100');
        setProducts(p);
      } catch (e: any) {
        setErr(e.message);
      }
    })();
  }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!query.trim()) {
        try {
          setProducts(await api<Product[]>('/api/products?limit=100'));
        } catch {}
        return;
      }
      try {
        setProducts(await api<Product[]>(`/api/products/search?q=${encodeURIComponent(query.trim())}`));
      } catch {}
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const subtotal = cart.reduce((s, l) => s + l.unitPriceCents * l.qty, 0);
  const vatPreview = Math.round(subtotal * vatRate);
  const totalPreview = subtotal + vatPreview;

  const checkout = async (method: 'cash' | 'promptpay' | 'card') => {
    if (!session || cart.length === 0) return;
    setErr(null);
    setBusy(true);
    try {
      // Card path: take the tap/swipe first, then build the body with the
      // resulting last4. Refunds are still handled server-side via CN.
      let paymentPart: Record<string, unknown>;
      if (method === 'cash') {
        paymentPart = { method: 'cash', amountCents: totalPreview, tenderedCents: totalPreview, changeCents: 0 };
      } else if (method === 'promptpay') {
        if (!thaiMode) throw new Error('PromptPay is Thai-mode only');
        paymentPart = { method: 'promptpay', amountCents: totalPreview };
      } else {
        const r = await collectCardPayment(totalPreview, currency);
        if (r.status !== 'succeeded') throw new Error(`card ${r.status}`);
        paymentPart = { method: 'card', amountCents: totalPreview, cardLast4: r.last4 };
      }

      const body: Record<string, unknown> = {
        offlineId: uuidv7(),
        sessionId: session.id,
        lines: cart,
        currency,
        payment: paymentPart,
      };
      if (thaiMode && buyerTin) body.buyer = { tin: buyerTin };

      try {
        const resp = await api<CreateOrderResponse>('/api/pos/orders', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setLastResult(resp);
        // Best-effort thermal print. Ignores errors so a broken printer never
        // blocks a sale — cashier can reprint from recent-orders.
        printReceipt({
          documentType: resp.documentType,
          documentNumber: resp.documentNumber,
          createdAt: new Date().toISOString(),
          totalCents: resp.totalCents,
          taxCents: resp.taxCents,
          subtotalCents: resp.totalCents - resp.taxCents,
          paymentMethod: method,
          orderLines: cart,
          buyer: buyerTin ? { tin: buyerTin } : null,
          currency: resp.currency,
          promptpayQr: resp.promptpayQr,
        }).catch((e) => console.warn('[print]', e));
      } catch (e) {
        // Network/API failure → queue offline; cashier is told the order is
        // recorded locally and will sync when back online.
        if (e instanceof ApiError || (e as any)?.message?.includes('Network')) {
          await enqueue(body as { offlineId: string; sessionId: string });
          setLastResult({
            id: body.offlineId as string,
            documentType: 'RE',
            documentNumber: 'QUEUED',
            totalCents: totalPreview,
            taxCents: vatPreview,
            currency,
            promptpayQr: null,
          });
          // Try a drain in the background; no-op if still offline.
          drain().catch(() => {});
        } else {
          throw e;
        }
      }
      clear();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const closeSession = async () => {
    if (!session) return;
    try {
      await api(`/api/pos/sessions/${session.id}/close`, {
        method: 'POST',
        body: JSON.stringify({ countedBalanceCents: session.openingBalanceCents }),
      });
      setSession(null);
      navigation.replace('OpenSession');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.colors.background }}>
      {/* Left: products */}
      <View style={{ flex: 2, padding: 16 }}>
        <Searchbar placeholder="Search / scan..." value={query} onChangeText={setQuery} style={{ marginBottom: 12 }} />
        <FlatList
          data={products}
          numColumns={3}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ gap: 8 }}
          columnWrapperStyle={{ gap: 8 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => add({ id: item.id, name: item.name, priceCents: item.priceCents })}
              style={{ flex: 1, minHeight: 96 }}
            >
              <Card mode="elevated" style={{ padding: 12 }}>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {item.category ?? '—'}
                </Text>
                <Text variant="titleSmall" numberOfLines={2}>
                  {item.name}
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.primary, marginTop: 4 }}>
                  {fmt(item.priceCents)}
                </Text>
              </Card>
            </Pressable>
          )}
        />
      </View>

      <Divider style={{ width: 1, height: '100%' }} />

      {/* Right: cart */}
      <View style={{ flex: 1, padding: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text variant="titleLarge">{thaiMode ? 'ตะกร้า' : 'Cart'} ({cart.length})</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <IconButton
              icon="barcode-scan"
              size={24}
              onPress={() => navigation.navigate('Scanner')}
              accessibilityLabel="Scan barcode"
            />
            <Button compact onPress={closeSession}>Close</Button>
          </View>
        </View>

        <ScrollView style={{ flex: 1 }}>
          {cart.length === 0 ? (
            <Text style={{ color: theme.colors.onSurfaceVariant, padding: 32, textAlign: 'center' }}>
              Tap a product to add
            </Text>
          ) : (
            cart.map((l) => (
              <Card key={l.productId} style={{ marginBottom: 6, padding: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyMedium" numberOfLines={1}>{l.name}</Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {fmt(l.unitPriceCents)} × {l.qty}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Button compact mode="outlined" onPress={() => inc(l.productId, -1)}>−</Button>
                    <Text>{l.qty}</Text>
                    <Button compact mode="outlined" onPress={() => inc(l.productId, 1)}>+</Button>
                    <Button compact onPress={() => remove(l.productId)}>✕</Button>
                  </View>
                </View>
              </Card>
            ))
          )}
        </ScrollView>

        <Divider style={{ marginVertical: 8 }} />

        {thaiMode && (
          <View style={{ marginBottom: 8 }}>
            <TextInput
              label="Buyer TIN (optional, 13 digits)"
              value={buyerTin}
              onChangeText={setBuyerTin}
              keyboardType="numeric"
              mode="outlined"
              dense
            />
          </View>
        )}

        <View style={{ marginBottom: 8 }}>
          <Text>Subtotal: {fmt(subtotal)}</Text>
          {vatRate > 0 && (
            <Text>
              {thaiMode ? 'VAT' : 'Tax'} {(vatRate * 100).toFixed(2)}%: {fmt(vatPreview)}
            </Text>
          )}
          <Text variant="titleMedium">Total: {fmt(totalPreview)}</Text>
        </View>

        {err && <Text style={{ color: theme.colors.error, marginBottom: 6 }}>{err}</Text>}

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button mode="contained" style={{ flex: 1 }} onPress={() => checkout('cash')} disabled={busy || cart.length === 0}>
            Cash
          </Button>
          {thaiMode && (
            <Button mode="contained-tonal" style={{ flex: 1 }} onPress={() => checkout('promptpay')} disabled={busy || cart.length === 0}>
              QR
            </Button>
          )}
          <Button mode="outlined" style={{ flex: 1 }} onPress={() => checkout('card')} disabled={busy || cart.length === 0}>
            Card
          </Button>
        </View>

        {lastResult && (
          <Card style={{ marginTop: 12, padding: 12 }}>
            <Text variant="titleSmall">
              {lastResult.documentType} {lastResult.documentNumber}
            </Text>
            <Text variant="bodySmall">Total {formatMoney(lastResult.totalCents, lastResult.currency, locale)}</Text>
            {lastResult.promptpayQr && (
              <Text variant="bodySmall" numberOfLines={3} selectable>
                QR: {lastResult.promptpayQr}
              </Text>
            )}
          </Card>
        )}
      </View>
    </View>
  );
}
