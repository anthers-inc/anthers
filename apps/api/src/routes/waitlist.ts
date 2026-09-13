// SPDX-License-Identifier: Apache-2.0
/**
 * The pre-launch waitlist: one email to the contact inbox per signup, and nothing retained.
 *
 * 🚨 **It sends through `sendEmail` like every other message, and must.** It used to build its
 * own Resend client with `onboarding@resend.dev` as the sender — the sandbox address Resend
 * delivers only to the account owner — so it bypassed the verified `anthers.org` sender the
 * email service was fixed to use, and a signup to any other inbox could only fail. Sending
 * through the service also brings its test-runner guard and its logging.
 *
 * The submitted address is escaped into the HTML: it passed an email check, which is not the
 * same thing as being safe to interpolate into markup.
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { escapeHtml, sendEmail } from "../services/email.js";

/** Where a signup is announced. */
export const WAITLIST_INBOX = "contact@anthers.org";

const waitlistSchema = z.object({
	email: z.string().email().max(254),
	interest: z.enum(["user", "creator", "both"]),
});

/** The notification for one signup. Exported so its escaping is testable without a send. */
export function waitlistMessage(email: string, interest: "user" | "creator" | "both") {
	const interestLabel =
		interest === "both" ? "Both (User & Creator)" : interest === "creator" ? "Creator" : "User";
	return {
		to: WAITLIST_INBOX,
		subject: `Waitlist signup: ${email}`,
		html: `
			<h2>New Waitlist Signup</h2>
			<p><strong>Email:</strong> ${escapeHtml(email)}</p>
			<p><strong>Interested as:</strong> ${interestLabel}</p>
		`,
	};
}

export const waitlistRoutes = new Hono().post(
	"/",
	zValidator("json", waitlistSchema),
	async (c) => {
		const { email, interest } = c.req.valid("json");
		const { sent } = await sendEmail(waitlistMessage(email, interest));
		if (!sent) return c.json({ error: "Could not record the signup" }, 503);
		return c.json({ ok: true });
	},
);
