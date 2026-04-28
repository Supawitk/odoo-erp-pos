import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';

export type CountryMode = 'TH' | 'GENERIC';

export interface OrgSettings {
  id: string;
  countryMode: CountryMode;
  vatRegistered: boolean;
  currency: string;
  locale: string;
  timezone: string;
  sellerName: string;
  sellerTin: string | null;
  sellerBranch: string;
  sellerAddress: string;
  vatRate: number;
  defaultVatMode: 'inclusive' | 'exclusive';
  abbreviatedTaxInvoiceCapCents: number;
  promptpayBillerId: string | null;
  fxSource: string;
}

/**
 * Singleton in-memory cache shared across iPad screens. Settings change rarely
 * (manager flips Thai mode, etc.) so we cache aggressively, refresh on mount,
 * and let the web Settings page be the source of truth.
 */
let cache: OrgSettings | null = null;
const listeners = new Set<(s: OrgSettings | null) => void>();

async function fetchSettings(): Promise<OrgSettings> {
  const next = await api<OrgSettings>('/api/settings');
  cache = next;
  listeners.forEach((l) => l(next));
  return next;
}

export function useOrgSettings() {
  const [settings, setSettings] = useState<OrgSettings | null>(cache);
  const [loading, setLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listeners.add(setSettings);
    if (!cache) {
      setLoading(true);
      fetchSettings()
        .catch((e: unknown) => setError((e as Error).message))
        .finally(() => setLoading(false));
    }
    return () => {
      listeners.delete(setSettings);
    };
  }, []);

  const refresh = useCallback(async () => {
    cache = null;
    return fetchSettings();
  }, []);

  return { settings, loading, error, refresh };
}

/**
 * Format a satang/cent amount per the org's locale + currency. Thai mode uses
 * the ฿ symbol and Buddhist-era-friendly Intl.NumberFormat; generic mode falls
 * back to the standard ISO 4217 currency rendering.
 */
export function formatMoney(cents: number, currency: string, locale = 'th-TH'): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).format(cents / 100);
  } catch {
    // Fallback for currencies the runtime doesn't know about.
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}
