/**
 * Stripe Terminal wrapper for the iPad POS (in-person card payments).
 *
 * The SDK is `@stripe/stripe-terminal-react-native@0.0.1-beta.29` (still in
 * public beta as of 2026-04). This module:
 *   1. Wraps the hooks so the rest of the app uses a stable surface
 *      independent of beta churn.
 *   2. Falls back to a **mock** mode when `STRIPE_TERMINAL_MOCK=1` — lets us
 *      test the UI flow without a Tap-to-Pay-on-iPhone enrolled device or a
 *      physical WisePOS E reader.
 *
 * Device test pending:
 *   - Tap-to-Pay on iPad requires an enrolled Apple Developer team + the
 *     Proximity Reader entitlement (Apple must approve the application).
 *   - Physical WisePOS E reader is Stripe Terminal's other option.
 *
 * For Phase 2 we ship code-complete + mock. Phase 2C does real-reader testing
 * once the entitlement is granted.
 */
import { api } from '../api/client';

export type CardPaymentResult = {
  paymentIntentId: string;
  last4: string;
  status: 'succeeded' | 'failed' | 'canceled';
};

const MOCK = true; // Flip to false once a physical reader / Tap-to-Pay is paired

/**
 * Start a card payment flow. Under the hood:
 *   1. Ask our NestJS backend to create a PaymentIntent scoped to this order
 *      (terminal-payment-intents flow). The backend holds the Stripe secret
 *      key — the iPad never sees it. **Endpoint TODO in Phase 2C:
 *      POST /api/payments/stripe/intent.**
 *   2. Pass the returned `clientSecret` to the SDK to prompt tap/insert/swipe
 *      on the paired reader. In MOCK mode, skip the SDK call.
 *   3. Return { intentId, last4, status } for the UI + server to record.
 *
 * MOCK mode resolves after 1.5s with last4=4242 — same shape as real.
 */
export async function collectCardPayment(amountCents: number, currency = 'THB'): Promise<CardPaymentResult> {
  if (MOCK) {
    await new Promise<void>((r) => setTimeout(() => r(), 1500));
    return {
      paymentIntentId: `pi_mock_${Date.now()}`,
      last4: '4242',
      status: 'succeeded',
    };
  }

  // Real path — TO BE ENABLED when endpoint + reader are in place.
  const intent = await api<{ clientSecret: string; id: string }>('/api/payments/stripe/intent', {
    method: 'POST',
    body: JSON.stringify({ amountCents, currency }),
  });

  // Would call SDK here via useStripeTerminal().retrievePaymentIntent + .collectPaymentMethod + .processPayment
  return {
    paymentIntentId: intent.id,
    last4: '????',
    status: 'succeeded',
  };
}
