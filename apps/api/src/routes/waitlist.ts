import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { Resend } from "resend";
import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const waitlistSchema = z.object({
	email: z.string().email().max(254),
	interest: z.enum(["user", "creator", "both"]),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

export const waitlistRoutes = new Hono().post(
	"/",
	zValidator("json", waitlistSchema),
	async (c) => {
		const { email, interest } = c.req.valid("json");

		const apiKey = process.env.RESEND_API_KEY;
		if (!apiKey) {
			console.error("RESEND_API_KEY is not configured");
			return c.json({ error: "Email service not configured" }, 503);
		}

		const interestLabel =
			interest === "both" ? "Both (User & Creator)" : interest === "creator" ? "Creator" : "User";

		const resend = new Resend(apiKey);

		const { error } = await resend.emails.send({
			from: "Anthers Waitlist <onboarding@resend.dev>",
			to: "contact@anthers.org",
			subject: `Waitlist signup: ${email}`,
			html: `
				<h2>New Waitlist Signup</h2>
				<p><strong>Email:</strong> ${email}</p>
				<p><strong>Interested as:</strong> ${interestLabel}</p>
			`,
		});

		if (error) {
			console.error("Failed to send waitlist email:", error);
			return c.json({ error: "Failed to send notification" }, 500);
		}

		return c.json({ ok: true });
	},
);
