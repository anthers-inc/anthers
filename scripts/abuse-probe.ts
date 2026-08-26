// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fire real illegal-content reports at a deployed Anthers and report how far each one got.
 *
 * 🚨 **What this can and cannot settle, because the boundary is the whole point.** It can
 * prove a report was accepted, that the right row was written, and that `escalated_at` was
 * stamped — which means Resend accepted the message. It **cannot** prove the mail arrived,
 * and it cannot prove the phone alert fired. `abuse@anthers.org` is single-recipient by
 * policy (60.13 § 5.4), so nobody but its owner can see inside it. That last step is
 * deliberately left to a person, and this script exists to make sure it is the *only* step
 * left to a person.
 *
 * ⭐ **It drives HTTP and nothing else.** No `DATABASE_URL`, no direct writes, no fixture
 * tables — the account, the Work and the comment are all created the way a real creator
 * would, so running it against production is an ordinary use of the product rather than an
 * exception to the rule that fixture scripts never touch it. That also means it exercises
 * the real path: CSRF, sessions, validation, and the ingress in front of all of it.
 *
 * ⚠️ **`assertDevCheckout()` would not have protected production here anyway.** That guard
 * asks whether the code is running from a repository checkout, not which database it is
 * pointed at, so a fixture script run from a developer's machine with a production
 * `DATABASE_URL` sails straight through it. Reaching for HTTP is what actually keeps this
 * safe, rather than a guard that reads as though it would.
 *
 * Usage:
 *   bun run scripts/abuse-probe.ts --base https://anthers.org \
 *       --admin-login you@example.com --admin-password '…' [--fixture] [--cleanup]
 *
 *   --fixture   also create a Work and a comment, so the in-app report path can be tested.
 *               Without it only the public no-account form is exercised, which needs no
 *               content at all.
 *   --cleanup   remove the Work this run created and close the reports it filed.
 *   --wait      seconds to wait for the retry sweep before giving up (default 360; the
 *               cron runs every five minutes, so anything under 300 can report a false
 *               "never escalated").
 */

interface Args {
	base: string;
	adminLogin?: string;
	adminPassword?: string;
	fixture: boolean;
	cleanup: boolean;
	waitSeconds: number;
}

function parseArgs(argv: string[]): Args {
	const get = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const base = (get("base") ?? "http://localhost:8000").replace(/\/+$/, "");
	return {
		base,
		// `--admin-email` stays accepted because it is the obvious thing to type, but the
		// field is a LOGIN: `/api/auth/sign-in` takes `{ login, password }` and resolves a
		// username or an email against it. Sending `{ email }` gets a 400 from the schema,
		// which reads as bad credentials and is not.
		adminLogin: get("admin-login") ?? get("admin-email"),
		adminPassword: get("admin-password"),
		fixture: argv.includes("--fixture"),
		cleanup: argv.includes("--cleanup"),
		waitSeconds: Number(get("wait") ?? 360),
	};
}

const args = parseArgs(process.argv.slice(2));

/**
 * The Origin every request carries.
 *
 * `csrfProtection` compares it against the allowed origins, so a request without one is
 * refused on a mutating route. Derived from `--base` rather than hard-coded, so pointing
 * the probe at a preview deployment does not silently fail CSRF and read as a code fault.
 */
const ORIGIN = new URL(args.base).origin;

function log(line: string) {
	console.log(line);
}

async function call(
	path: string,
	init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: any; setCookie: string | null }> {
	const { cookie, ...rest } = init;
	const res = await fetch(`${args.base}${path}`, {
		...rest,
		headers: {
			"Content-Type": "application/json",
			Origin: ORIGIN,
			...(cookie ? { Cookie: cookie } : {}),
			...(rest.headers ?? {}),
		},
	});
	const text = await res.text();
	let body: any = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: res.status, body, setCookie: res.headers.get("set-cookie") };
}

function sessionCookie(setCookie: string | null): string | null {
	return setCookie ? setCookie.split(";")[0] : null;
}

/** A tag every artifact this run creates carries, so a later cleanup can find its own. */
const RUN = new Date()
	.toISOString()
	.replace(/[^0-9]/g, "")
	.slice(0, 14);
const TAG = `abuse-probe-${RUN}`;

async function signInAdmin(): Promise<string | null> {
	if (!args.adminLogin || !args.adminPassword) return null;
	const res = await call("/api/auth/sign-in", {
		method: "POST",
		body: JSON.stringify({ login: args.adminLogin, password: args.adminPassword }),
	});
	if (res.status !== 200) {
		log(`  ! admin sign-in failed (${res.status}) — the readback will be skipped`);
		return null;
	}
	return sessionCookie(res.setCookie);
}

/**
 * A creator account, a Work, and a comment on it — the minimum an in-app report needs.
 *
 * The comment is reported by the same account that wrote it, which the moderation service
 * allows on purpose for content: a report is currently the only way an author can ask for
 * their own words to come down. That keeps this to one new account rather than two.
 */
async function createFixture(): Promise<{
	cookie: string;
	username: string;
	workId: number;
	commentId: number;
} | null> {
	const username = `probe_${RUN}`.slice(0, 30);
	const signUp = await call("/api/auth/sign-up", {
		method: "POST",
		body: JSON.stringify({
			username,
			email: `${username}@anthers.org`,
			password: `Probe-${RUN}-pw`,
			acceptTerms: true,
		}),
	});
	if (signUp.status !== 201) {
		log(
			`  ! could not create the probe account (${signUp.status}): ${JSON.stringify(signUp.body)}`,
		);
		return null;
	}
	const cookie = sessionCookie(signUp.setCookie);
	if (!cookie) {
		log("  ! sign-up returned no session cookie");
		return null;
	}

	const work = await call("/api/content/works", {
		method: "POST",
		cookie,
		body: JSON.stringify({
			type: "text",
			title: `Probe fixture ${TAG}`,
			bodyHtml: "<p>Fixture.</p>",
		}),
	});
	if (work.status !== 201) {
		log(`  ! could not create the fixture Work (${work.status}): ${JSON.stringify(work.body)}`);
		return null;
	}
	const workId = work.body.work.id as number;

	const comment = await call(`/api/content/works/${workId}/comments`, {
		method: "POST",
		cookie,
		body: JSON.stringify({ body: `Fixture comment for ${TAG}. Safe to delete.` }),
	});
	if (comment.status !== 201) {
		log(`  ! could not create the fixture comment (${comment.status})`);
		return null;
	}

	log(`  · fixture: @${username}, Work ${workId}, comment ${comment.body.comment.id}`);
	return { cookie, username, workId, commentId: comment.body.comment.id as number };
}

interface Probe {
	kind: "public" | "in-app";
	reportId: number;
	/** Whether the alert had gone out by the time the run finished. */
	escalated?: boolean | null;
	/**
	 * What the provider says became of the message.
	 *
	 * ⭐ **This is the rung above `escalated`.** `escalated` means Resend accepted the
	 * message, which is a fact about our side of a network call; this is Resend's own
	 * account of what happened to it afterwards. `delivered` here means the receiving
	 * server took it — which is as far as any machine can honestly get.
	 */
	delivery?: { event: string; delivered: boolean; terminal: boolean } | null;
}

async function main() {
	log(`abuse-probe → ${args.base}`);
	log(`  run tag: ${TAG}`);

	const adminCookie = await signInAdmin();
	if (adminCookie) log("  · signed in as admin — readback enabled");
	else log("  · no admin session — reports will be filed but not read back");

	const probes: Probe[] = [];

	// ── The public, no-account report ────────────────────────────────────────
	// Deliberately first, and deliberately sends no Cookie: this is the path a member of
	// the public takes, and it is the one where the reporter has no other channel, so a
	// silent failure here is the one nobody would ever find out about.
	log("\nFiling the public no-account report…");
	const publicRes = await call("/api/moderation/abuse-reports", {
		method: "POST",
		body: JSON.stringify({
			url: `${args.base}/works/probe-fixture`,
			reason: "illegal",
			details: `Automated escalation probe (${TAG}). Not a real report — safe to dismiss.`,
		}),
	});
	if (publicRes.status === 201) {
		log(`  ✓ accepted, report #${publicRes.body.reportId}`);
		probes.push({ kind: "public", reportId: publicRes.body.reportId });
	} else {
		log(`  ✗ REFUSED (${publicRes.status}): ${JSON.stringify(publicRes.body)}`);
		if (publicRes.status === 401) {
			log("    401 means the route has grown an auth requirement — that is the whole bug.");
		}
	}

	// ── The in-app, authenticated report ─────────────────────────────────────
	let fixture: Awaited<ReturnType<typeof createFixture>> = null;
	if (args.fixture) {
		log("\nCreating the fixture content…");
		fixture = await createFixture();
		if (fixture) {
			log("Filing the in-app report…");
			// `sexual` on purpose: its own hint reads "any sexual content involving minors",
			// so it is the reason the form steers a real CSAM reporter toward, and an
			// escalation wired only to `illegal` would pass every other test and miss it.
			const inApp = await call("/api/moderation/reports", {
				method: "POST",
				cookie: fixture.cookie,
				body: JSON.stringify({
					subjectType: "comment",
					subjectId: fixture.commentId,
					reason: "sexual",
					details: `Automated escalation probe (${TAG}). Not a real report — safe to dismiss.`,
				}),
			});
			if (inApp.status === 201) {
				log(`  ✓ accepted, report #${inApp.body.reportId}`);
				probes.push({ kind: "in-app", reportId: inApp.body.reportId });
			} else {
				log(`  ✗ REFUSED (${inApp.status}): ${JSON.stringify(inApp.body)}`);
			}
		}
	} else {
		log("\nSkipping the in-app report — pass --fixture to create content and test it too.");
	}

	if (probes.length === 0) {
		log("\nNothing was filed. Stopping.");
		process.exit(1);
	}

	// ── Readback ─────────────────────────────────────────────────────────────
	// `escalated_at` is stamped only after Resend accepts the message, so it is what
	// separates "the send failed" from "the send worked and the mailbox ate it". The
	// inline send happens on file, and the retry cron re-selects anything still null
	// every five minutes — hence the default wait.
	if (adminCookie) {
		log(`\nWatching for the escalation stamp (up to ${args.waitSeconds}s)…`);
		const deadline = Date.now() + args.waitSeconds * 1000;
		while (Date.now() < deadline) {
			for (const probe of probes) {
				if (!probe.escalated) {
					probe.escalated = await readEscalated(probe, adminCookie, fixture?.commentId);
				}
				// Only ask about delivery once there is a message to ask about, and keep
				// asking until the provider stops changing its mind — `queued` and `sent`
				// are both way-stations rather than answers.
				if (probe.escalated && !probe.delivery?.terminal) {
					probe.delivery = await readDelivery(probe, adminCookie);
				}
			}
			if (probes.every((p) => p.escalated && p.delivery?.terminal)) break;
			await new Promise((r) => setTimeout(r, 15_000));
		}
	}

	// ── Verdict ──────────────────────────────────────────────────────────────
	log("\n─────────────────────────────────────────────────────────────");
	for (const probe of probes) {
		const label = probe.kind === "public" ? "public form " : "in-app report";
		if (probe.escalated === undefined) {
			log(`  ${label}  #${probe.reportId}  filed — not read back (no admin session)`);
		} else if (!probe.escalated) {
			log(`  ${label}  #${probe.reportId}  NOT ESCALATED — the send failed`);
		} else if (probe.delivery?.delivered) {
			log(
				`  ${label}  #${probe.reportId}  DELIVERED — the mailbox accepted it (${probe.delivery.event})`,
			);
		} else if (probe.delivery?.terminal) {
			log(
				`  ${label}  #${probe.reportId}  NOT DELIVERED — the provider reports "${probe.delivery.event}"`,
			);
		} else if (probe.delivery) {
			log(`  ${label}  #${probe.reportId}  IN FLIGHT — accepted, still "${probe.delivery.event}"`);
		} else {
			log(`  ${label}  #${probe.reportId}  ESCALATED — accepted, delivery unknown`);
		}
	}
	log("─────────────────────────────────────────────────────────────");
	log("\nWhat a machine cannot answer, and so is left to a person:");
	// DELIVERED is as far as this can honestly go. The receiving server accepting a
	// message says nothing about whether it was filed somewhere a human looks, and the
	// phone alert is a rule inside the mailbox that nothing here can see.
	log("  • Is it in the inbox rather than spam or a folder nobody opens?");
	log("  • Did the phone alert fire?");
	log("\nReading the verdict:");
	log("  DELIVERED + you see it        → it works, end to end.");
	log("  DELIVERED + you do not        → the mailbox took it and filed it out of sight.");
	log("                                  The fault is a mail rule, not the code.");
	log("  NOT DELIVERED                 → the provider rejected or bounced it. Check that");
	log("                                  noreply@anthers.org is still a verified sender");
	log("                                  and that abuse@anthers.org actually accepts mail.");
	log("  NOT ESCALATED                 → the send never happened. Check the worker is");
	log("                                  running, then RESEND_API_KEY.");

	if (args.cleanup) await cleanup(adminCookie, fixture, probes);
	else if (fixture) log(`\nFixture left in place. Re-run with --cleanup to remove it.`);
}

/** What the provider says became of this report's alert. Null while unknown. */
async function readDelivery(probe: Probe, adminCookie: string): Promise<Probe["delivery"]> {
	const kind = probe.kind === "public" ? "abuse" : "report";
	const res = await call(`/api/admin/escalation-delivery?kind=${kind}&id=${probe.reportId}`, {
		cookie: adminCookie,
	});
	if (res.status !== 200) return null;
	return res.body?.status ?? null;
}

/** Whether this report's alert has gone out, read over the admin API. */
async function readEscalated(
	probe: Probe,
	adminCookie: string,
	commentId?: number,
): Promise<boolean | null> {
	if (probe.kind === "public") {
		const res = await call("/api/admin/abuse-reports?closed=1", { cookie: adminCookie });
		if (res.status !== 200) return null;
		const row = (res.body.reports ?? []).find((r: any) => r.id === probe.reportId);
		return row ? Boolean(row.escalatedAt) : null;
	}
	// The moderation queue is keyed by subject rather than by report, so the comment is
	// what identifies it. `floorAlerted` is false while any floor report on that subject
	// is still unescalated, which is exactly the question being asked.
	const res = await call("/api/admin/moderation?filter=reported", { cookie: adminCookie });
	if (res.status !== 200) return null;
	const item = (res.body.items ?? []).find(
		(i: any) => i.subjectType === "comment" && i.subjectId === commentId,
	);
	return item ? Boolean(item.floorAlerted) : null;
}

/**
 * Remove what this run created.
 *
 * 🚨 **Reports are closed, never deleted.** A report is a record, and the whole moderation
 * model rests on removal being a state — so cleanup dismisses them, which is the outcome
 * an operator would reach for a report that turned out to need nothing. The Work and its
 * comment do go, because those are fixture content rather than a record of anything.
 *
 * The probe account is left in place: deletion is scheduled rather than immediate here,
 * and an account with no content is a smaller footprint than a half-run deletion.
 */
async function cleanup(
	adminCookie: string | null,
	fixture: Awaited<ReturnType<typeof createFixture>>,
	probes: Probe[],
): Promise<void> {
	log("\nCleaning up…");
	if (fixture) {
		const del = await call(`/api/content/works/${fixture.workId}?force=true`, {
			method: "DELETE",
			cookie: fixture.cookie,
		});
		// 204 is a real delete; 200 means the Work was WITHDRAWN rather than destroyed
		// because somebody had bought it, which cannot happen to a fixture but is the
		// documented other outcome and is not a failure.
		log(
			del.status === 204 || del.status === 200
				? `  · removed Work ${fixture.workId} and its comment`
				: `  ! could not remove Work ${fixture.workId} (${del.status})`,
		);
		log(`  · left the probe account @${fixture.username} in place`);
	}
	if (!adminCookie) {
		log("  ! no admin session — the reports were left open");
		return;
	}
	for (const probe of probes) {
		if (probe.kind === "public") {
			const res = await call("/api/admin/abuse-reports/close", {
				method: "POST",
				cookie: adminCookie,
				body: JSON.stringify({ reportId: probe.reportId, outcome: "dismissed" }),
			});
			log(
				res.status === 200
					? `  · dismissed public report #${probe.reportId}`
					: `  ! could not dismiss public report #${probe.reportId} (${res.status})`,
			);
		} else if (fixture) {
			const res = await call("/api/admin/moderation/dismiss", {
				method: "POST",
				cookie: adminCookie,
				body: JSON.stringify({ subjectType: "comment", subjectId: fixture.commentId }),
			});
			log(
				res.status === 200
					? `  · dismissed the in-app report on comment ${fixture.commentId}`
					: `  ! could not dismiss the in-app report (${res.status})`,
			);
		}
	}
}

main().catch((err) => {
	console.error("abuse-probe failed:", err);
	process.exit(1);
});
