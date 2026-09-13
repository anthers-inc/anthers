// SPDX-License-Identifier: Apache-2.0
/**
 * Whether the signed-in creator's payouts are set up, so a publish control can say so before
 * it is clicked.
 *
 * Publishing anything — releasing a Work, publishing or scheduling a post, publishing a
 * project — takes completed payout setup, and `publishRefusal` in the API is the authority.
 *
 * 🚨 **A prediction, never the decision.** This exists for the same reason a release checkbox
 * stays disabled until a rating is picked: don't offer a click that fails. `null` means the
 * answer has not arrived, and a control should stay enabled until it does — a creator whose
 * status request failed should meet the server's refusal, not a disabled button with no
 * explanation. So callers test `=== false`, never `!ready`.
 */

import { useEffect, useState } from "react";
import { client } from "./rpc";

export function usePayoutsReady(): boolean | null {
	const [ready, setReady] = useState<boolean | null>(null);

	useEffect(() => {
		let live = true;
		client.api.payments.stripe.onboard
			.$get()
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as {
					payoutsEnabled: boolean | null;
					onboardingComplete: boolean | null;
				};
				// Both flags, matching the server's predicate exactly. Onboarding can finish while
				// Stripe still declines to send money, and only the second answers "can this
				// creator be paid".
				if (live) setReady(data.payoutsEnabled === true && data.onboardingComplete === true);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	return ready;
}
