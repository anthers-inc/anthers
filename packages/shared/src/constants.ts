// SPDX-License-Identifier: AGPL-3.0-or-later
export const APP_NAME = "Anthers";
/**
 * Anthers Foundation Fee — a single unified 8% rate applied to BOTH subscription
 * revenue and direct-purchase transactions. This is the one source of truth for
 * the Foundation Fee percentage; import it wherever the fee is computed rather
 * than hardcoding a literal, so the rate can never drift between call sites.
 */
export const FOUNDATION_FEE_PERCENTAGE = 8;
