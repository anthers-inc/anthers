// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound webhooks from providers that are not Stripe.
 *
 * Stripe's lives on `/api/payments/stripe/webhook`, beside the payments it is about. This
 * router exists because the next one — Resend's delivery events — belongs to no domain in
 * particular: it reports on escalation alerts *and* signup verifications *and* everything
 * else we send, so filing it under moderation or auth would misdescribe it.
 *
 * 🚨 **Everything here runs before authentication and is reachable by anyone**, which is
 * the whole reason each handler's first act is to verify a signature against a shared
 * secret. A webhook endpoint that trusts its payload is an unauthenticated write API.
 */

import { Hono } from "hono";
import { standardWebhookHeaders, verifyStandardWebhook } from "../lib/standard-webhooks.js";
import { normalizeEventName, recordDeliveryEvent } from "../services/delivery-events.js";
import { receiveMerchWebhook } from "../services/printful.js";
import { checkRate, clientIp } from "../services/rate-limit.js";

const webhookRoutes = new Hono()
	/**
	 * Resend delivery events — `email.delivered`, `email.bounced`, and the rest.
	 *
	 * ⭐ **This exists so that nothing needs an API key that can read mail.** Production's
	 * `RESEND_API_KEY` is send-only, and broadening it would give the credential most
	 * exposed in production the power to read every message we have ever sent, purely to
	 * answer a question Resend is willing to push to us. See `services/delivery-events.ts`.
	 */
	.post("/resend", async (c) => {
		const secret = process.env.RESEND_WEBHOOK_SECRET?.trim() ?? "";

		// 🚨 The RAW body, read before anything parses it. The signature covers the exact
		// bytes, so a `c.req.json()` here and a re-serialization later would invalidate
		// every genuine delivery — the same trap the Stripe handler documents.
		const raw = await c.req.text();
		const verdict = verifyStandardWebhook({
			secret,
			headers: standardWebhookHeaders((name) => c.req.header(name)),
			body: raw,
		});

		if (!verdict.ok) {
			// The reason goes to our logs and never to the sender: returning it would turn
			// this into an oracle distinguishing a wrong signature from a stale timestamp.
			console.warn(`[resend-webhook] rejected: ${verdict.reason}`);
			return c.json({ error: "Signature verification failed." }, 400);
		}

		let payload: { type?: string; created_at?: string; data?: { email_id?: string } };
		try {
			payload = JSON.parse(raw);
		} catch {
			return c.json({ error: "Malformed payload." }, 400);
		}

		const messageId = payload.data?.email_id;
		const type = payload.type;
		if (!messageId || !type) {
			// Signed by us, so this is a shape we do not recognize rather than an intrusion.
			// 200 rather than 400: a provider that gets an error re-delivers, and retrying
			// a payload we will never understand is a loop rather than a recovery.
			return c.json({ ok: true, matched: 0, reason: "unrecognized_payload" });
		}

		const occurredAt = payload.created_at ? new Date(payload.created_at) : new Date();
		const { matched } = await recordDeliveryEvent({
			messageId,
			event: normalizeEventName(type),
			occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
		});

		// ⚠️ `matched: 0` is the ORDINARY case and must stay a success. Resend sends an
		// event for every email we send, and the overwhelming majority are signup
		// verifications that no report row names. Answering 4xx to those would make the
		// endpoint look broken in Resend's dashboard and invite retries forever.
		return c.json({ ok: true, matched });
	})

	/**
	 * Printful fulfillment events — `package_shipped`, order state changes, the rest.
	 *
	 * 🚨 **Every payload here is a hint, never the truth.** Printful's v1 webhooks carry no
	 * signing secret (verified against the live v1 docs, 2026-10-08 — the webhook section
	 * describes no signature and the payload schema carries none), so the receiver's first
	 * act is never to trust the payload: it joins on the Printful order id from a payload
	 * it accepts as an unauthenticated *pointer*, then **re-reads the order from
	 * Printful's API** and writes state only from what the API answers. A forged payload
	 * can make us fetch an order we own — it cannot make us record state we do not own,
	 * because the write happens only from the API's answer.
	 *
	 * ⚠️ The unauthenticated-write rule: this door joins the shared per-IP limiter —
	 * `merch:webhook`, generous, because Printful retries on any non-2xx (1, 4, 16, 64 …
	 * minutes) and a refusal loops.
	 */
	.post("/printful", async (c) => {
		const verdict = await checkRate("merch:webhook", clientIp(c.req.raw.headers), 60, 60);
		if (!verdict.ok) return c.json({ error: "Too many requests." }, 429);

		const body = (await c.req.json().catch(() => null)) as {
			type?: string;
			data?: { order?: { id?: number } } | null;
		} | null;
		// A payload without a type or an order id names nothing — accepted (200) so the
		// sender stops retrying, recorded as nothing. Same shape as the Resend door.
		if (!body?.type || !body.data?.order?.id)
			return c.json({ ok: true, matched: 0, reason: "unrecognized_payload" });

		const { matched, reason } = await receiveMerchWebhook(body.type, body.data.order.id);
		// `matched: 0` is likewise ordinary — events about orders Anthers holds no
		// fulfillment row for (a manual dashboard order, another store's) answer success.
		return c.json({ ok: true, matched, ...(reason ? { reason } : {}) });
	});

export { webhookRoutes };
