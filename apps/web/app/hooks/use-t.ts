import { useOrgSettings } from "./use-org-settings";
import { getStrings } from "~/lib/i18n";

/**
 * Hook returning the active translation table. Usage:
 *   const t = useT();
 *   <h1>{t.dashboard_title}</h1>
 *   <span>{t.stat_orders_count(5)}</span>
 *
 * Reactive: if the user toggles country mode in /settings, every component
 * using useT() re-renders automatically because useOrgSettings subscribes to
 * the cache.
 */
export function useT() {
  const { settings } = useOrgSettings();
  return getStrings(settings?.countryMode);
}
