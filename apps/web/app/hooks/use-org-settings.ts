import { useCallback, useEffect, useState } from "react";
import { api } from "~/lib/api";

export type CountryMode = "TH" | "GENERIC";

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
  defaultVatMode: "inclusive" | "exclusive";
  abbreviatedTaxInvoiceCapCents: number;
  promptpayBillerId: string | null;
  fxSource: string;
}

/**
 * Shared org settings hook. Caches the GET in a module-level store so every
 * page gets the same snapshot without refetching on each mount, and an update
 * from the Settings page invalidates all consumers.
 */
let cache: OrgSettings | null = null;
const listeners = new Set<(s: OrgSettings | null) => void>();

async function refresh(): Promise<OrgSettings> {
  const next = await api<OrgSettings>("/api/settings");
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
      refresh()
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }
    return () => { listeners.delete(setSettings); };
  }, []);

  const update = useCallback(async (patch: Partial<OrgSettings>) => {
    const next = await api<OrgSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    cache = next;
    listeners.forEach((l) => l(next));
    return next;
  }, []);

  return { settings, loading, error, update, refresh };
}
