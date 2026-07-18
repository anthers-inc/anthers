// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Server-side Stripe client — one shared instance built from STRIPE_SECRET_KEY.
 *
 * Null when the key is absent (a test run or a not-yet-configured environment) so
 * routes can return a clean 503 instead of the module throwing at import time. The
 * SDK picks its own pinned API version; we don't override it.
 */
import Stripe from "stripe";

const secretKey = process.env.STRIPE_SECRET_KEY?.trim();

export const stripe: Stripe | null = secretKey ? new Stripe(secretKey) : null;
