// Components shared across the financial-report tabs (Balance Sheet, P&L,
// Cash Flow). Extracted from the previously monolithic accounting.tsx.

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { formatMoney } from "~/lib/api";
import type { FsRow } from "./types";

export function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-base font-semibold tabular-nums">{children}</p>
    </div>
  );
}

export function FsSectionCard({
  title,
  rows,
  totalCents,
  currency,
  useThai,
  extraRow,
}: {
  title: string;
  rows: FsRow[];
  totalCents: number;
  currency: string;
  useThai: boolean;
  extraRow?: { label: string; amountCents: number };
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        {rows.length === 0 && !extraRow ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {useThai ? "ไม่มีรายการ" : "No entries."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.accountCode} className="border-b last:border-0">
                  <td className="px-4 py-1.5 font-mono text-xs text-muted-foreground">
                    {r.accountCode}
                  </td>
                  <td className="px-4 py-1.5">{r.accountName}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">
                    {formatMoney(r.balanceCents, currency)}
                  </td>
                </tr>
              ))}
              {extraRow && (
                <tr className="border-b last:border-0 bg-muted/20">
                  <td className="px-4 py-1.5 font-mono text-xs text-muted-foreground"></td>
                  <td className="px-4 py-1.5 italic">{extraRow.label}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums italic">
                    {formatMoney(extraRow.amountCents, currency)}
                  </td>
                </tr>
              )}
              <tr className="bg-muted/40">
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2 font-semibold">
                  {useThai ? "รวม" : "Total"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-bold">
                  {formatMoney(totalCents, currency)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
