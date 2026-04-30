import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { AppSidebar } from "./app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "~/components/ui/sidebar";
import { Separator } from "~/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Button } from "~/components/ui/button";
import { LogOut, Loader2 } from "lucide-react";
import { useT } from "~/hooks/use-t";
import { useAuth } from "~/lib/auth";
import { api, API_BASE } from "~/lib/api";

export default function DashboardLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const { user, accessToken, refreshToken, hydrated, clear } = useAuth();

  // Redirect to /login when storage rehydrated and no token present.
  useEffect(() => {
    if (!hydrated) return;
    if (!accessToken) {
      navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
    }
  }, [hydrated, accessToken, location.pathname, navigate]);

  // Refresh user profile on token presence (catches role changes by admin).
  useEffect(() => {
    if (!accessToken) return;
    api<import("~/lib/auth").AuthUser>("/api/auth/me")
      .then((u) => useAuth.getState().setUser(u))
      .catch(() => {});
  }, [accessToken]);

  const handleLogout = async () => {
    try {
      if (refreshToken) {
        await fetch(`${API_BASE}/api/auth/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken ?? ""}`,
          },
          body: JSON.stringify({ refreshToken }),
        });
      }
    } catch {
      // best effort — clear regardless
    }
    clear();
    navigate("/login", { replace: true });
  };

  if (!hydrated || !accessToken || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const ROUTE_LABELS: Record<string, string> = {
    "/": t.nav_dashboard,
    "/pos": t.nav_pos,
    "/inventory": t.nav_inventory,
    "/bills": t.nav_bills,
    "/sales": t.nav_sales,
    "/accounting": t.nav_accounting,
    "/reports": t.nav_reports,
    "/hr": t.nav_hr,
    "/crm": t.nav_crm,
    "/analysis": t.nav_analysis,
    "/settings": t.nav_settings,
  };
  const currentLabel = ROUTE_LABELS[location.pathname] ?? t.page;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1 h-10 w-10 touch-manipulation [&_svg]:!size-5" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/">{t.appName}</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>{currentLabel}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden flex-col items-end text-xs leading-tight md:flex">
              <span className="font-medium">{user.name}</span>
              <span className="text-muted-foreground">
                {user.username ?? user.email ?? user.id.slice(0, 8)} ·{" "}
                <span className="font-mono uppercase">{user.role}</span>
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              title="Sign out"
              className="h-10 w-10 touch-manipulation [&_svg]:!size-5"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
