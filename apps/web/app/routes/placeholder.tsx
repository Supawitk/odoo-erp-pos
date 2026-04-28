import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useLocation } from "react-router";

const PAGE_META: Record<string, { title: string; description: string; phase: string; features: string[] }> = {
  "/pos": {
    title: "Point of Sale",
    description: "Web POS fallback — primary POS is the iPad React Native app",
    phase: "Phase 2",
    features: ["Product grid + categories", "Cart + checkout", "Payment processing", "Receipt generation", "Offline mode"],
  },
  "/inventory": {
    title: "Inventory",
    description: "Stock management, warehouses, and product catalog",
    phase: "Phase 3",
    features: ["Product management", "Multi-warehouse stock", "Stock transfers", "Reorder rules", "Valuation (FIFO/LIFO)"],
  },
  "/sales": {
    title: "Sales",
    description: "Quotations, sales orders, and customer transactions",
    phase: "Phase 2-3",
    features: ["Quote → Order pipeline", "Customer management", "Pricing rules", "Discounts & promotions"],
  },
  "/accounting": {
    title: "Accounting",
    description: "Double-entry bookkeeping and financial reports",
    phase: "Phase 4",
    features: ["Chart of Accounts", "Journal entries", "Balance Sheet / P&L", "Bank reconciliation", "Multi-currency"],
  },
  "/reports": {
    title: "Reports",
    description: "Analytics and business intelligence",
    phase: "Phase 5",
    features: ["Sales analytics", "Inventory reports", "Financial dashboards", "CSV/PDF export", "Custom report builder"],
  },
  "/hr": {
    title: "HR",
    description: "Human resources and payroll",
    phase: "Phase 6",
    features: ["Employee management", "Attendance tracking", "Leave management", "Payroll processing"],
  },
  "/crm": {
    title: "CRM",
    description: "Customer relationship management",
    phase: "Phase 7",
    features: ["Lead pipeline", "Contact management", "Email campaigns", "Loyalty program"],
  },
  "/settings": {
    title: "Settings",
    description: "System configuration and user management",
    phase: "Phase 9",
    features: ["User & roles (ABAC)", "Odoo connection", "Payment providers", "Tax configuration"],
  },
};

export default function Placeholder() {
  const location = useLocation();
  const meta = PAGE_META[location.pathname] ?? {
    title: "Page",
    description: "",
    phase: "TBD",
    features: [],
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{meta.title}</h1>
          <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
            {meta.phase}
          </span>
        </div>
        <p className="text-muted-foreground">{meta.description}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming in {meta.phase}</CardTitle>
          <CardDescription>
            This page is a preview of the navigation. Features will be built in the upcoming phases.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {meta.features.map((feature) => (
              <li key={feature} className="flex items-center gap-2 text-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                {feature}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
