// SPDX-License-Identifier: Apache-2.0
/**
 * The purchase-transfer retry — the worklist of creator shares the completion path could
 * not move, re-attempted until they land.
 *
 * A completed purchase's creator share moves out at the charge's completion
 * (`services/purchase-split.ts`). That call can fail — a Stripe blip, a creator's account
 * mid-restriction — and the failure leaves the rows `stripe_transfer_id`-null, logged,
 * owed. This sweep re-attempts every owed group through the same idempotency key the
 * completion path used, so a retry can never double-transfer and a crash between Stripe's
 * call and the row stamping replays the original instead of a second one.
 *
 * Cadence: every fifteen minutes, because this is money a creator has already earned
 * sitting on the platform balance — the exact posture the split decision exists to keep
 * to seconds, and a retry that waits for the small hours extends a minutes-long hold
 * into a day-long one for no reason. The scan is one query on an empty worklist, so the
 * cadence costs nothing when nothing is owed.
 *
 * Idempotent by construction: only `completed` rows with a null transfer match, and a
 * purchase that refunded or disputed in the window never matches again — the buyer's
 * money for that item is gone from the charge, so no share of it may ever move.
 */

import { retryFailedTransfers } from "../services/purchase-split.js";

export async function runPurchaseTransferRetry(): Promise<number> {
	return retryFailedTransfers();
}
