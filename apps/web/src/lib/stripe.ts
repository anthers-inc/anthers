import { loadStripe } from "@stripe/stripe-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publishableKey: string =
	(globalThis as any).__STRIPE_PUBLISHABLE_KEY__ || "";

export const stripePromise = publishableKey ? loadStripe(publishableKey) : null;
