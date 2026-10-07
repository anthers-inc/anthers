// SPDX-License-Identifier: Apache-2.0
/**
 * The status routes — the public read the /status page polls, and the droplet's ingest.
 *
 * 🚨 **GET /api/status is the public answer and carries nothing but states and sentences.**
 * The deepened `/health` holds the numeric truth (probe timings, queue depths); anything
 * this route carried beyond a state would put a load fingerprint on a public, unthrottled
 * route — the exact line the task's public-copy rule draws. It is read by the page every
 * 30 seconds, so it must stay cheap: both probes are reads, and neither writes.
 *
 * **POST /api/heartbeat is the droplet's ingest and carries the one secret this feature
 * introduces.** Auth is a bearer token (`HEARTBEAT_TOKEN`) rather than a session, because
 * the reporter is a machine on another failure domain, not a person with an account — the
 * same transport rule the desktop's bearer middleware carries, without the session lookup
 * (there is no session to validate; the token IS the authorization). It is deliberately
 * not on `requireAuth`, which would model a person where there is a machine.
 */
import { Hono } from "hono";
import { statusReport } from "../services/status.js";
import { recordHeartbeat, type HeartbeatVerdict } from "../services/heartbeat.js";

/** The bearer header's token, as the heartbeat route reads it. */
function heartbeatToken(header: string | undefined): string | null {
	if (!header) return null;
	const [scheme, ...rest] = header.split(" ");
	if (scheme?.toLowerCase() !== "bearer") return null;
	const token = rest.join(" ").trim();
	return token.length > 0 ? token : null;
}

export const statusRoutes = new Hono()
	.get("/", async (c) => {
		// No cache, no rate limit needed: this is the route the page polls, and every probe
		// it makes is a read. Answered from the composed reports in services/status.ts.
		return c.json(await statusReport());
	})
	.post("/heartbeat", async (c) => {
		// 🚨 Constant-time comparison, not string equality — the same discipline any
		// secret-on-the-wire comparison carries, and one line to keep.
		const expected = process.env.HEARTBEAT_TOKEN?.trim() ?? "";
		const presented = heartbeatToken(c.req.header("Authorization")) ?? "";
		if (!expected || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
			return c.json({ error: "Not found" }, 404);
		}
		const body = await c.req.json().catch(() => null);
		const verdict = (body as { verdict?: string } | null)?.verdict;
		if (verdict !== "up" && verdict !== "down" && verdict !== "degraded") {
			return c.json({ error: "A verdict of up, down or degraded is required." }, 400);
		}
		await recordHeartbeat({
			verdict: verdict as HeartbeatVerdict,
			detail: typeof (body as { detail?: string }).detail === "string" ? (body as { detail: string }).detail : undefined,
			checkedAt: typeof (body as { checkedAt?: string }).checkedAt === "string" ? (body as { checkedAt: string }).checkedAt : undefined,
		});
		return c.json({ ok: true });
	});

/**
 * Length-first, token-time comparison. `crypto.timingSafeEqual` refuses mismatched lengths
 * (which would itself leak the length), so lengths are checked first and the comparison
 * runs only between equal-length buffers.
 */
function timingSafeEqual(presented: string, expected: string): boolean {
	if (presented.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}