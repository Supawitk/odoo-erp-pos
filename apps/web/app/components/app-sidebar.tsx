import { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Calculator,
  Users,
  FileBarChart,
  Settings,
  Briefcase,
  Store,
  Sparkles,
  ChevronDown,
} from "lucide-react";
import { Link, useLocation } from "react-router";
import { io, type Socket } from "socket.io-client";
import { API_BASE, api } from "~/lib/api";
import { useAuth } from "~/lib/auth";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
} from "~/components/ui/sidebar";
import { useT } from "~/hooks/use-t";

interface NavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Built and ready to use — no "soon" badge */
  ready: boolean;
  /** Optional badge slot — string when present, hidden when null/undefined */
  badge?: string | number | null;
  badgeTone?: "warning" | "info";
}
interface NavGroup {
  /** Stable id used as the localStorage key — independent of i18n label */
  id: string;
  label: string;
  defaultOpen: boolean;
  items: NavItem[];
}

const STORAGE_PREFIX = "sidebar:group-open:";

function readOpenState(id: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const v = localStorage.getItem(STORAGE_PREFIX + id);
  if (v === null) return fallback;
  return v === "1";
}
function writeOpenState(id: string, open: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_PREFIX + id, open ? "1" : "0");
}

export function AppSidebar() {
  const location = useLocation();
  const t = useT();
  const isAdmin = useAuth((s) => s.user?.role === "admin");

  // Live low-stock count for the Inventory nav item.
  const [lowStockCount, setLowStockCount] = useState<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const refresh = () =>
      api<unknown[]>("/api/inventory/low-stock")
        .then((rows) => {
          if (!cancelled) setLowStockCount(Array.isArray(rows) ? rows.length : 0);
        })
        .catch(() => {
          if (!cancelled) setLowStockCount(null);
        });
    refresh();
    let sock: Socket | null = null;
    try {
      sock = io(API_BASE, { transports: ["websocket"], reconnection: true });
      sock.on("inventory:low-stock", refresh);
      sock.on("pos:order:created", refresh);
    } catch {
      // socket optional; nav still works without live updates
    }
    return () => {
      cancelled = true;
      sock?.disconnect();
    };
  }, []);

  const navGroups: NavGroup[] = [
    {
      id: "overview",
      label: t.group_overview,
      defaultOpen: true,
      items: [{ title: t.nav_dashboard, url: "/", icon: LayoutDashboard, ready: true }],
    },
    {
      id: "operations",
      label: t.group_operations,
      defaultOpen: true,
      items: [
        { title: t.nav_pos, url: "/pos", icon: ShoppingCart, ready: true },
        {
          title: t.nav_inventory,
          url: "/inventory",
          icon: Package,
          ready: true,
          badge: lowStockCount && lowStockCount > 0 ? lowStockCount : null,
          badgeTone: "warning",
        },
        { title: t.nav_sales, url: "/sales", icon: Store, ready: true },
      ],
    },
    {
      id: "finance",
      label: t.group_finance,
      defaultOpen: true,
      items: [
        { title: t.nav_accounting, url: "/accounting", icon: Calculator, ready: true },
        { title: t.nav_reports, url: "/reports", icon: FileBarChart, ready: false },
      ],
    },
    {
      id: "management",
      label: t.group_management,
      defaultOpen: false,
      items: [
        { title: t.nav_hr, url: "/hr", icon: Users, ready: false },
        { title: t.nav_crm, url: "/crm", icon: Briefcase, ready: false },
        { title: t.nav_settings, url: "/settings", icon: Settings, ready: true },
      ],
    },
  ];

  if (isAdmin) {
    navGroups[0].items.push({
      title: t.nav_analysis,
      url: "/analysis",
      icon: Sparkles,
      ready: true,
      badge: t.nav_admin_only,
      badgeTone: "info",
    });
  }

  // Per-group collapse state, persisted to localStorage. Initial value matches
  // SSR (defaultOpen) so HTML is stable; client effect rehydrates from
  // localStorage on mount.
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(navGroups.map((g) => [g.id, g.defaultOpen])),
  );

  useEffect(() => {
    setOpenMap((prev) => {
      const next: Record<string, boolean> = {};
      for (const g of navGroups) {
        next[g.id] = readOpenState(g.id, g.defaultOpen);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) =>
    setOpenMap((prev) => {
      const next = !prev[id];
      writeOpenState(id, next);
      return { ...prev, [id]: next };
    });

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex flex-col px-2 py-3">
          <span className="text-base font-semibold leading-tight">{t.appName}</span>
          <span className="text-xs text-muted-foreground">v0.0.1</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group) => {
          const open = openMap[group.id] ?? group.defaultOpen;
          // Auto-open the group containing the current route, even if the user
          // collapsed it — otherwise the active item would be invisible.
          const groupOwnsActive = group.items.some((i) => i.url === location.pathname);
          const effectiveOpen = open || groupOwnsActive;

          return (
            <SidebarGroup key={group.id}>
              <SidebarGroupLabel
                render={
                  <button
                    type="button"
                    onClick={() => toggle(group.id)}
                    aria-expanded={effectiveOpen}
                    className="flex h-9 w-full items-center justify-between text-[13px] hover:text-foreground cursor-pointer touch-manipulation select-none"
                  >
                    <span>{group.label}</span>
                    <ChevronDown
                      className={
                        "h-4 w-4 transition-transform " +
                        (effectiveOpen ? "" : "-rotate-90")
                      }
                    />
                  </button>
                }
              />
              {effectiveOpen && (
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => {
                      const isActive = location.pathname === item.url;
                      const Icon = item.icon;
                      return (
                        <SidebarMenuItem key={item.url}>
                          <SidebarMenuButton
                            isActive={isActive}
                            size="lg"
                            render={
                              <Link
                                to={item.url}
                                className="flex items-center gap-3 text-[15px] touch-manipulation [&_svg]:!size-5"
                              >
                                <Icon />
                                <span className="flex-1">{item.title}</span>
                                {item.badge != null && (
                                  <span
                                    className={
                                      "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums " +
                                      (item.badgeTone === "warning"
                                        ? "bg-amber-100 text-amber-700"
                                        : "bg-blue-100 text-blue-700")
                                    }
                                    aria-label={`${item.badge} alert`}
                                  >
                                    {item.badge}
                                  </span>
                                )}
                                {!item.ready && (
                                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {t.nav_soon}
                                  </span>
                                )}
                              </Link>
                            }
                          />
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              )}
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-2.5 px-2 py-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-medium">
            AD
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium">Admin</span>
            <span className="text-xs text-muted-foreground">admin@erp.local</span>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
