// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The first half of the signup ceremony: confirm the address, in place.
 *
 * `/subscribe` collects an email and nothing else. Submitting opens this — **a code
 * box, not a payment box** — and only once the address is confirmed does anything ask
 * for money. Parker's reasoning for that order: every account should arrive with a
 * confirmed address, and the public page should ask for as little as it possibly can.
 *
 * 🚨 **A free account walks the same path.** Verification is not the price of paying;
 * it is how an account comes into existence, so someone who picks nothing at all still
 * confirms their address and still ends up somewhere real. Skipping it for free accounts
 * would leave exactly the accounts least likely to ever confirm as the unconfirmed ones.
 *
 * What this component does NOT do is take the payment. Verifying issues a session
 * cookie, so by the time this closes the browser is signed in and the rest is an
 * ordinary authenticated call through the existing preview + `SubscriptionPaymentModal`
 * machinery — the same ceremony the inline post unlock uses, unchanged. Splitting it
 * here is what stopped this from having to grow its own card field and its own idea of
 * what a charge looks like.
 *
 * It also does not send anyone away. The picks live in this page's state, so a redirect
 * to a signup route is what the old flow did and what cost the choices someone had just
 * made.
 *
 * ⚠️ **The field itself lives in `components/auth/EmailCodeModal`**, which `/login` also
 * renders for signing in with an empty password. This file is what remains once the copy
 * and the endpoint are the only differences: the ceremony's reasoning, and the fact that
 * verifying here may **create an account** — the one thing the login door must never do.
 */

import { client } from "@anthers/web-shared/rpc";
import { useCallback } from "react";
import EmailCodeModal from "../auth/EmailCodeModal";

interface Props {
	/** The address the code went to — echoed back so a typo is visible before retrying. */
	email: string;
	/** Whether anything is being paid for, which decides what the step label promises. */
	paying: boolean;
	/**
	 * Verified. The browser now holds a session; the caller takes it from here — either
	 * into payment or straight to onboarding.
	 */
	onVerified: (result: { created: boolean; needsOnboarding: boolean }) => void;
	onClose: () => void;
}

export default function SignupCeremonyModal({ email, paying, onVerified, onClose }: Props) {
	const submit = useCallback(
		async (code: string) => {
			const res = await client.api.auth.signup.verify.$post({ json: { email, code } });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? "That code didn't work. Check it, or ask for a new one.");
			}
			onVerified((await res.json()) as { created: boolean; needsOnboarding: boolean });
		},
		[email, onVerified],
	);

	const resend = useCallback(async () => {
		await client.api.auth.signup.start.$post({ json: { email } });
	}, [email]);

	return (
		<EmailCodeModal
			stepLabel={paying ? "Step 1 of 2" : "Verify your email"}
			lede={
				<>
					We sent a six-character code to <strong className="break-all">{email}</strong>. Enter it
					and you're verified.
				</>
			}
			cta="Verify my email"
			busyLabel="Checking…"
			onSubmit={submit}
			onResend={resend}
			onClose={onClose}
		/>
	);
}
