// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useRef, useState } from "react";

type Status = "idle" | "verifying" | "success" | "error";

export default function VerifyEmailPage() {
	const [params] = useSearchParams();
	const token = params.get("token");
	const { user, refreshUser } = useAuth();
	const [status, setStatus] = useState<Status>(token ? "verifying" : "idle");
	const [message, setMessage] = useState("");
	const [resending, setResending] = useState(false);
	const [resent, setResent] = useState(false);
	const ran = useRef(false);

	useEffect(() => {
		if (!token || ran.current) return;
		ran.current = true;
		client.api.auth["verify-email"]
			.$post({ json: { token } })
			.then(async (res) => {
				if (res.ok) {
					setStatus("success");
					await refreshUser();
				} else {
					const data = (await res.json().catch(() => null)) as { error?: string } | null;
					setStatus("error");
					setMessage(data?.error ?? "This verification link is invalid or has expired.");
				}
			})
			.catch(() => {
				setStatus("error");
				setMessage("Something went wrong verifying your email.");
			});
	}, [token, refreshUser]);

	const handleResend = async () => {
		setResending(true);
		try {
			const res = await client.api.auth["resend-verification"].$post();
			if (res.ok) setResent(true);
		} finally {
			setResending(false);
		}
	};

	const canResend = !!user && !user.emailVerified;
	const resendControl = resent ? (
		<p className="text-success text-sm">A fresh verification email is on its way.</p>
	) : (
		<button
			type="button"
			className="btn btn-outline btn-sm"
			onClick={handleResend}
			disabled={resending}
		>
			{resending ? "Sending…" : "Resend verification email"}
		</button>
	);

	let idleText = "Open the verification link from your welcome email to confirm your address.";
	if (user?.emailVerified) idleText = "Your email is already verified.";
	else if (user) idleText = "Check your inbox for a verification link. Didn't get one?";

	return (
		<div className="max-w-md mx-auto px-4 py-16 text-center">
			<h1 className="text-2xl font-bold mb-6">Email verification</h1>

			{status === "verifying" && (
				<div className="flex flex-col items-center gap-4">
					<LoadingSpinner size="lg" />
					<p className="text-base-content/60">Verifying your email…</p>
				</div>
			)}

			{status === "success" && (
				<div className="flex flex-col items-center gap-4">
					<div className="text-5xl">✅</div>
					<p className="text-base-content/80">Your email is verified. You're all set.</p>
					<Link to="/feed" className="btn btn-primary">
						Continue
					</Link>
				</div>
			)}

			{status === "error" && (
				<div className="flex flex-col items-center gap-4">
					<div className="text-5xl">⚠️</div>
					<p className="text-base-content/80">{message}</p>
					{canResend && resendControl}
				</div>
			)}

			{status === "idle" && (
				<div className="flex flex-col items-center gap-4">
					<p className="text-base-content/70">{idleText}</p>
					{canResend && resendControl}
					{user?.emailVerified && (
						<Link to="/feed" className="btn btn-primary">
							Continue
						</Link>
					)}
				</div>
			)}
		</div>
	);
}
