// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useState } from "react";

/** Persistent prompt shown to logged-in users who haven't verified their email. */
export default function VerificationBanner() {
	const { user } = useAuth();
	const [resending, setResending] = useState(false);
	const [resent, setResent] = useState(false);

	if (!user || user.emailVerified) return null;

	const handleResend = async () => {
		setResending(true);
		try {
			const res = await client.api.auth["resend-verification"].$post();
			if (res.ok) setResent(true);
		} finally {
			setResending(false);
		}
	};

	return (
		<div className="bg-warning/15 border-b border-warning/30 text-sm">
			<div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3 flex-wrap">
				<ExclamationTriangleIcon className="w-4 h-4 text-warning shrink-0" />
				<span className="text-base-content/80">
					Verify your email to unlock purchases, funding, and creator mode.
				</span>
				{resent ? (
					<span className="text-success ml-auto">Verification email sent.</span>
				) : (
					<button
						type="button"
						className="btn btn-warning btn-xs ml-auto"
						onClick={handleResend}
						disabled={resending}
					>
						{resending ? "Sending…" : "Resend email"}
					</button>
				)}
			</div>
		</div>
	);
}
