import { Outlet, useLocation } from "react-router";
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
import { useT } from "~/hooks/use-t";

export default function DashboardLayout() {
  const location = useLocation();
  const t = useT();

  const ROUTE_LABELS: Record<string, string> = {
    "/": t.nav_dashboard,
    "/pos": t.nav_pos,
    "/inventory": t.nav_inventory,
    "/sales": t.nav_sales,
    "/accounting": t.nav_accounting,
    "/reports": t.nav_reports,
    "/hr": t.nav_hr,
    "/crm": t.nav_crm,
    "/settings": t.nav_settings,
  };
  const currentLabel = ROUTE_LABELS[location.pathname] ?? t.page;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
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
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
