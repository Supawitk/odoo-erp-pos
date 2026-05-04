/**
 * @deprecated Re-export shim. The canonical WHT helpers live in @erp/shared
 * because the same Thai rate table applies to both AP (we withhold) and AR
 * (customers withhold from us). New code should import from `@erp/shared`.
 */
export { whtRateBp, computeWhtCents, type WhtCategory } from '@erp/shared';
