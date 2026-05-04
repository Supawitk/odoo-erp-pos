import { useEffect, useState } from "react";
import { api } from "~/lib/api";

export interface CashAccount {
  code: string;
  nameTh: string | null;
  nameEn: string | null;
}

/**
 * Shared cash-accounts hook. Drives every dropdown that needs to pick a
 * cash account (POS receipts, AP/AR payments, bank reconciliation). The
 * list is the chart_of_accounts rows where is_cash_account = true.
 *
 * Cached at module level so flipping pages doesn't refetch. Call
 * `refresh()` from a settings UI after toggling the flag if needed.
 */
let cache: CashAccount[] | null = null;
const listeners = new Set<(rows: CashAccount[]) => void>();

async function fetchAccounts(): Promise<CashAccount[]> {
  const rows = await api<CashAccount[]>("/api/accounting/chart-of-accounts/cash");
  cache = rows;
  listeners.forEach((l) => l(rows));
  return rows;
}

export function useCashAccounts() {
  const [accounts, setAccounts] = useState<CashAccount[]>(cache ?? []);
  const [loading, setLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listeners.add(setAccounts);
    if (!cache) {
      setLoading(true);
      fetchAccounts()
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }
    return () => {
      listeners.delete(setAccounts);
    };
  }, []);

  return {
    accounts,
    loading,
    error,
    /** Code of the lowest-numbered cash account; used as a sensible default. */
    primaryCode: accounts[0]?.code ?? "1120",
    refresh: fetchAccounts,
  };
}
