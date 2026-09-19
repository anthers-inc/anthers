// SPDX-License-Identifier: Apache-2.0
/**
 * File **one** real illegal-content report at a deployed Anthers and say how far it got.
 *
 * 🛑 **This never runs unattended, and that is a decision rather than a default** (Parker,
 * 2026-08-27): *"we should never run unattended tests of content reports, especially safety
 * or abuse ones. At most we should be able to explicitly run a single-email test to ensure
 * the system is functioning, which then needs its database cruft immediately cleared out. We
 * never want to automate or bulk-test the reporting, because it adds noise to a system that
 * always needs to be attended diligently."*
 *
 * Three things follow from that, and each is enforced here rather than left to discipline:
 *
 * 1. **It refuses to start without a terminal.** `process.stdin.isTTY` is the mechanical
 *    statement of "a person is here" — a cron job, a CI step and a `bash -c` from a deploy
 *    hook all fail it. A `CI` environment variable is refused as well, because a terminal
 *    can be allocated in CI and the check would otherwise pass in the one place it exists to
 *    fail.
 * 2. **One report per run.** The path is chosen, never accumulated: `--path public` or
 *    `--path in-app`, and there is no way to ask for both. Two alerts prove nothing the
 *    first did not, and every extra one teaches whoever reads that mailbox to skim it —
 *    which is the single habit the floor exists to prevent.
 * 3. **Cleanup is unconditional.** It is not a flag, it runs in a `finally`, and it runs
 *    when the probe fails as well as when it passes. The run that most needs tidying up
 *    after is the one that fell over halfway.
 *
 * 🚨 **The admin password is prompted for and never read from anywhere else.** It used to be
 * `--admin-password`, which put a production credential into shell history and into whatever
 * transcript the command was run from. Passing it now is **refused rather than accepted**:
 * silently ignoring the flag would leave the secret in the history anyway and teach nobody.
 * Nothing here writes the password to disk, to an environment variable, or to the log.
 *
 * ⚠️ **An admin account is needed for exactly one thing — reading the escalation state back**,
 * and closing the report afterwards, over `/api/admin/*`, which is operator information by
 * design, since the report route deliberately tells a reporter nothing about what happens next.
 * Without it the report is still filed; what is lost is the answer. The admin account is a
 * separate identity from the Anthers account the in-app report is filed from, so the two are
 * signed in separately: the Anthers account with its password, and the admin account with a
 * code emailed to it, at the host the admin routes answer on.
 *
 * 🚨 **What this can and cannot settle, because the boundary is the whole point.** It can
 * prove a report was accepted, that the right row was written, and that `escalated_at` was
 * stamped — which means Resend accepted the message. It **cannot** prove the mail arrived,
 * and it cannot prove the phone alert fired. `abuse@anthers.org` is single-recipient by
 * policy (Child Safety Reporting Policy § 5.4), so nobody but its owner can see inside it. That last step is
 * deliberately left to a person, and this script exists to make sure it is the *only* step
 * left to a person.
 *
 * ⭐ **It drives HTTP and nothing else.** No `DATABASE_URL`, no direct writes, no fixture
 * tables — the draft post and the comment are created the way a real creator would, from the
 * operator's own session, so running it against production is an ordinary use of the product rather than an
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
 *     --admin you@example.com --admin-base https://admin.anthers.org
 *
 *   --path        which single report to file: `public` (the no-account form, the default) or
 *                 `in-app` (the authenticated route, which needs --login and creates a draft
 *                 post and a comment from that account to report, removing them afterwards).
 *   --login       the Anthers account the in-app report is filed from, by username or email.
 *   --admin       the admin account that reads the escalation back and closes the report.
 *   --admin-base  where the admin routes answer. Defaults to --base, which is right for a local
 *                 API; a deployment needs the admin host.
 *   --wait      seconds to wait for the retry sweep before giving up (default 360; the
 *               cron runs every five minutes, so anything under 300 can report a false
 *               "never escalated").
 *
 * The Anthers account's password and the admin account's emailed code are both asked for on the
 * terminal. There is no flag for either.
 */

import { promptHidden } from "./terminal.ts";

/** Which single report this run files. There is deliberately no way to ask for both. */
export type ProbePath = "public" | "in-app";

export interface ProbePlan {
	base: string;
	/** Where the admin routes answer: the admin host on a deployment, the API itself locally. */
	adminBase: string;
	path: ProbePath;
	/**
	 * The Anthers account the in-app report is filed from. `/api/auth/sign-in` takes
	 * `{ login, password }` and resolves a username **or** an email against it, so this is a
	 * LOGIN rather than an email. Sending `{ email }` gets a 400 from the schema, which reads as
	 * bad credentials and is not.
	 */
	login?: string;
	/** The admin account the readback signs in as, by the address its codes go to. */
	adminEmail?: string;
	waitSeconds: number;
}

/** Why the probe will not run. The message is the whole output — it is what a person reads. */
export interface ProbeRefusal {
	refuse: string;
}

export function isRefusal(plan: ProbePlan | ProbeRefusal): plan is ProbeRefusal {
	return "refuse" in plan;
}

/**
 * Decide what this invocation is, or refuse it.
 *
 * Pure, and exported, so the refusals have tests rather than a comment claiming they exist —
 * *where a document claims an absence, that absence needs a test.* Every branch here is a
 * rule from the module header, and each returns a sentence rather than a code, because the
 * person who trips one needs to know what to do instead.
 */
export function probePlan(
	argv: string[],
	env: Record<string, string | undefined>,
	isTty: boolean,
): ProbePlan | ProbeRefusal {
	const get = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};

	// 🚨 Refused rather than ignored. Ignoring it would leave the password in the shell
	// history exactly as before while reading as though the problem were solved, and the
	// person who typed it would learn nothing. The refusal is also the only moment anyone
	// gets told to rotate it.
	for (const flag of ["--admin-password", "--password", "--admin-pass"]) {
		if (argv.includes(flag)) {
			return {
				refuse:
					`${flag} is not accepted. The password is asked for on the terminal so that it ` +
					"reaches no shell history and no transcript.\n" +
					"Whatever you just typed is in your history now — clear it, and rotate it if it " +
					"was a real production credential.",
			};
		}
	}

	// The mechanical statement of "a person is here". A cron job, a CI step and a deploy
	// hook all fail it, which is the point: an abuse report is a request for somebody to
	// stop what they are doing and look, and nothing should be able to make one on a timer.
	if (!isTty) {
		return {
			refuse:
				"This has no terminal, so nobody is here to read the answer. The probe files a real " +
				"report that summons a real person, and it is never run unattended.",
		};
	}

	// Checked separately, because CI can allocate a terminal — which would make the check
	// above pass in the one environment it most exists to fail in.
	if (env.CI) {
		return {
			refuse:
				"CI is set. The probe files a real abuse report, and a report filed by a build is " +
				"noise in a queue whose whole value is that everything in it is real.",
		};
	}

	// Refused rather than reinterpreted. These named ONE account that did both jobs, and the two
	// jobs now belong to two different identities, so guessing which one somebody meant would
	// sign the wrong kind of account in to the wrong half.
	for (const flag of ["--admin-login", "--admin-email"]) {
		if (argv.includes(flag)) {
			return {
				refuse:
					`${flag} is gone, because an admin account is no longer an Anthers account. Pass ` +
					"--login for the Anthers account the in-app report is filed from, and --admin for the " +
					"admin account that reads the escalation back.",
			};
		}
	}

	const rawPath = get("path") ?? "public";
	if (rawPath !== "public" && rawPath !== "in-app") {
		return { refuse: `Unknown --path "${rawPath}". It is either "public" or "in-app".` };
	}

	// The in-app report is filed from a signed-in account, and the only one the probe can sign in
	// is your own: accounts are made by an emailed-code ceremony nobody can script, so there is no
	// probe account to mint.
	const login = get("login");
	if (rawPath === "in-app" && !login) {
		return {
			refuse:
				"--path in-app needs --login. The report is filed from your own signed-in Anthers account, " +
				"because the probe cannot create one of its own.",
		};
	}

	const base = (get("base") ?? "http://localhost:8000").replace(/\/+$/, "");
	return {
		base,
		adminBase: (get("admin-base") ?? base).replace(/\/+$/, ""),
		path: rawPath,
		login,
		adminEmail: get("admin"),
		waitSeconds: Number(get("wait") ?? 360),
	};
}

/**
 * The invocation, and the origin derived from it.
 *
 * ⚠️ **Assigned inside `run()` rather than at the top level, and that is what makes this file
 * importable.** Everything above is pure and has tests; deciding the plan reads `process.argv`
 * and can call `process.exit`, so doing it on import would mean `import { probePlan }` from a
 * test killed the test runner — which is exactly what it did.
 */
let args!: ProbePlan;
let ORIGIN!: string;
let ADMIN_ORIGIN!: string;

function log(line: string) {
	console.log(line);
}

/**
 * `T` is what the caller expects back, taken on trust the way `res.json()` would be — a body
 * that is not JSON arrives as its text, and a status check before reading it is the guard.
 */
async function call<T = unknown>(
	path: string,
	init: RequestInit & { cookie?: string; admin?: boolean } = {},
): Promise<{ status: number; body: T; setCookie: string | null }> {
	const { cookie, admin, ...rest } = init;
	// The admin routes answer only on their own host and only from their own origin, so a call to
	// them goes there rather than to the site.
	const res = await fetch(`${admin ? args.adminBase : args.base}${path}`, {
		...rest,
		headers: {
			"Content-Type": "application/json",
			Origin: admin ? ADMIN_ORIGIN : ORIGIN,
			...(cookie ? { Cookie: cookie } : {}),
			...(rest.headers ?? {}),
		},
	});
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: res.status, body: body as T, setCookie: res.headers.get("set-cookie") };
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

/**
 * Sign in to your Anthers account, with a password that exists only as an argument.
 *
 * It is passed in rather than read off `args` so there is no field anywhere holding it —
 * the value is prompted for in `main`, handed here, and goes out of scope when this
 * returns. Nothing writes it to disk, to the environment, or to the log.
 */
async function signInAccount(login: string, password: string): Promise<string | null> {
	const res = await call("/api/auth/sign-in", {
		method: "POST",
		body: JSON.stringify({ login, password }),
	});
	if (res.status !== 200) {
		log(`  ! sign-in to ${login} failed (${res.status}) — the in-app report cannot be filed`);
		return null;
	}
	return sessionCookie(res.setCookie);
}

/**
 * Sign in to an admin account: ask for a code to be sent to it, then ask the person for the code.
 *
 * The code is read from the terminal without echoing, for the same reason the password is, and is
 * useless ten minutes later anyway.
 */
async function signInAdminAccount(email: string): Promise<string | null> {
	const start = await call("/api/admin/auth/signin/start", {
		method: "POST",
		admin: true,
		body: JSON.stringify({ email }),
	});
	if (start.status !== 200) {
		log(
			`  ! could not ask for an admin sign-in code (${start.status}) — the readback will be skipped`,
		);
		if (start.status === 404)
			log("    404 means --admin-base is not the host the admin routes answer on.");
		return null;
	}
	const code = await promptHidden(`  code emailed to ${email}: `);
	if (!code) return null;
	const verify = await call("/api/admin/auth/signin/verify", {
		method: "POST",
		admin: true,
		body: JSON.stringify({ email, code }),
	});
	if (verify.status !== 200) {
		log(`  ! admin sign-in failed (${verify.status}) — the readback will be skipped`);
		return null;
	}
	return sessionCookie(verify.setCookie);
}

/**
 * A draft post and a comment on it, made from your own account — the minimum an in-app report needs.
 *
 * Made from your own session, because no other account can be signed in from here:
 * accounts come from an emailed-code ceremony. A post rather than a Work because only posts
 * take comments. It stays a draft, so nobody else ever sees the fixture, and drafting a post
 * needs only creator mode on that account. The comment is reported by the same
 * account that wrote it, which the moderation service allows on purpose for content.
 */
async function createFixture(cookie: string): Promise<{
	cookie: string;
	postSlug: string;
	commentId: number;
} | null> {
	const draft = await call<{ post: { slug: string } }>("/api/content/posts", {
		method: "POST",
		cookie,
		body: JSON.stringify({ title: `Probe fixture ${TAG}`, isPublished: false }),
	});
	if (draft.status !== 201) {
		log(`  ! could not create the fixture post (${draft.status}): ${JSON.stringify(draft.body)}`);
		if (draft.status === 403) log("    403 means that account is not in creator mode.");
		return null;
	}
	const postSlug = draft.body.post.slug;

	const comment = await call<{ comment: { id: number } }>(
		`/api/content/posts/${postSlug}/comments`,
		{
			method: "POST",
			cookie,
			body: JSON.stringify({ body: `Fixture comment for ${TAG}. Safe to delete.` }),
		},
	);
	if (comment.status !== 201) {
		log(`  ! could not create the fixture comment (${comment.status})`);
		return { cookie, postSlug, commentId: 0 };
	}

	log(`  · fixture: draft post ${postSlug}, comment ${comment.body.comment.id}`);
	return { cookie, postSlug, commentId: comment.body.comment.id };
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

/**
 * What this run created, reachable from outside `main` so the cleanup can be a `finally`.
 *
 * 🚨 **Cleanup that lives at the end of `main` only runs when `main` reaches the end**, and
 * the run that most needs tidying up after is the one that fell over halfway. `probes` is
 * assigned once and pushed into, so the reference stays live; the other two are re-assigned
 * the moment they are known.
 */
const state: {
	adminCookie: string | null;
	fixture: Awaited<ReturnType<typeof createFixture>>;
	probes: Probe[];
} = { adminCookie: null, fixture: null, probes: [] };

/** Set when the probe filed nothing, so the exit code survives the cleanup below. */
let filedNothing = false;

async function main() {
	log(`abuse-probe → ${args.base}`);
	log(`  run tag: ${TAG}`);
	log(`  filing ONE report on the ${args.path} path`);

	// Asked for here and nowhere else. `signInAccount` takes the password as an argument so no
	// field holds it, and the Anthers account is only needed to file the in-app report.
	let accountCookie: string | null = null;
	if (args.login && args.path === "in-app") {
		const password = await promptHidden(`  password for ${args.login}: `);
		accountCookie = password ? await signInAccount(args.login, password) : null;
	}

	// The admin account is what reads the answer back. Without it the report is still filed and
	// only the answer is lost.
	let adminCookie: string | null = null;
	if (args.adminEmail) adminCookie = await signInAdminAccount(args.adminEmail);
	state.adminCookie = adminCookie;
	if (adminCookie) log("  · signed in to the admin account — readback enabled");
	else log("  · no admin session — the report will be filed but not read back");

	const probes: Probe[] = [];
	state.probes = probes;
	let fixture: Awaited<ReturnType<typeof createFixture>> = null;

	// ── The public, no-account report ────────────────────────────────────────
	// The default path, and deliberately sends no Cookie: this is the route a member of the
	// public takes, and it is the one where the reporter has no other channel, so a silent
	// failure here is the one nobody would ever find out about.
	if (args.path === "public") {
		log("\nFiling the public no-account report…");
		const publicRes = await call<{ reportId: number }>("/api/moderation/abuse-reports", {
			method: "POST",
			body: JSON.stringify({
				url: `${args.base}/works/probe-fixture`,
				reason: "illegal",
				details: `Attended escalation probe (${TAG}). Not a real report — safe to dismiss.`,
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
	}

	// ── The in-app, authenticated report ─────────────────────────────────────
	if (args.path === "in-app") {
		log("\nCreating the fixture content…");
		// `probePlan` refuses in-app without a login, so a missing session here is a sign-in that
		// failed rather than one nobody asked for.
		fixture = accountCookie ? await createFixture(accountCookie) : null;
		if (!accountCookie) log("  ! the sign-in failed, so there is no account to report from");
		state.fixture = fixture;
		// A fixture with no comment still comes back, so the cleanup can remove its draft post.
		if (fixture && fixture.commentId > 0) {
			log("Filing the in-app report…");
			// `csam` on purpose: it is the reason the form steers a real child-safety
			// reporter toward, and an escalation wired only to `illegal` would pass every
			// other test and miss the code the interface points the most serious report at.
			const inApp = await call<{ reportId: number }>("/api/moderation/reports", {
				method: "POST",
				cookie: fixture.cookie,
				body: JSON.stringify({
					subjectType: "comment",
					subjectId: fixture.commentId,
					reason: "csam",
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
	}

	// Nothing filed still runs the cleanup below — a half-created fixture is exactly the
	// litter that most needs removing, and it is the run that leaves it.
	if (probes.length === 0) {
		// Returned rather than exited, so the cleanup below still runs — `process.exit`
		// skips a `finally`, and a half-created fixture is exactly the litter this rule
		// exists for.
		log("\nNothing was filed.");
		filedNothing = true;
		return;
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
}

/** What the provider says became of this report's alert. Null while unknown. */
async function readDelivery(probe: Probe, adminCookie: string): Promise<Probe["delivery"]> {
	const kind = probe.kind === "public" ? "abuse" : "report";
	const res = await call<{ status?: Probe["delivery"] } | null>(
		`/api/admin/escalation-delivery?kind=${kind}&id=${probe.reportId}`,
		{
			cookie: adminCookie,
			admin: true,
		},
	);
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
		const res = await call<{ reports?: { id: number; escalatedAt: string | null }[] }>(
			"/api/admin/abuse-reports?closed=1",
			{ cookie: adminCookie, admin: true },
		);
		if (res.status !== 200) return null;
		const row = (res.body.reports ?? []).find((r) => r.id === probe.reportId);
		return row ? Boolean(row.escalatedAt) : null;
	}
	// The moderation queue is keyed by subject rather than by report, so the comment is
	// what identifies it. `floorAlerted` is false while any floor report on that subject
	// is still unescalated, which is exactly the question being asked.
	const res = await call<{
		items?: { subjectType: string; subjectId: number; floorAlerted: boolean }[];
	}>("/api/admin/moderation?filter=reported", { cookie: adminCookie, admin: true });
	if (res.status !== 200) return null;
	const item = (res.body.items ?? []).find(
		(i) => i.subjectType === "comment" && i.subjectId === commentId,
	);
	return item ? Boolean(item.floorAlerted) : null;
}

/**
 * Remove what this run created.
 *
 * 🚨 **Reports are closed, never deleted.** A report is a record, and the whole moderation
 * model rests on removal being a state — so cleanup dismisses them, which is the outcome
 * an operator would reach for a report that turned out to need nothing. The draft post and
 * its comment do go, because those are fixture content rather than a record of anything.
 *
 * No account is created, so none is left behind.
 */
async function cleanup(
	adminCookie: string | null,
	fixture: Awaited<ReturnType<typeof createFixture>>,
	probes: Probe[],
): Promise<void> {
	log("\nCleaning up…");
	if (fixture) {
		// Deleting the post takes its comments with it.
		const del = await call(`/api/content/posts/${fixture.postSlug}`, {
			method: "DELETE",
			cookie: fixture.cookie,
		});
		log(
			del.status === 204 || del.status === 200
				? `  · removed the draft post ${fixture.postSlug} and its comment`
				: `  ! could not remove the draft post ${fixture.postSlug} (${del.status})`,
		);
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
				admin: true,
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
				admin: true,
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

/**
 * 🚨 **Cleanup is unconditional, and not a flag.** Parker's rule (2026-08-27): a single
 * attended test whose database cruft is cleared immediately afterwards. A cleanup somebody
 * has to remember is one that happens on the runs that went well and not on the ones that
 * did not — and the failed run is the one that leaves a fixture behind.
 *
 * ⚠️ It is a `finally` rather than a line at the end of `main` for the same reason a test's
 * teardown belongs in `afterAll` rather than in a closing `it`: it has to run on failure.
 */
function run(): void {
	const planned = probePlan(process.argv.slice(2), process.env, Boolean(process.stdin.isTTY));
	if (isRefusal(planned)) {
		console.error(`abuse-probe refused to run.\n\n${planned.refuse}`);
		process.exit(2);
	}
	args = planned;
	// `csrfProtection` compares this against the allowed origins, so a request without one is
	// refused on a mutating route. Derived from `--base` rather than hard-coded, so pointing
	// the probe at a preview deployment does not silently fail CSRF and read as a code fault.
	ORIGIN = new URL(args.base).origin;
	ADMIN_ORIGIN = new URL(args.adminBase).origin;

	let exitCode = 0;
	main()
		.catch((err) => {
			console.error("abuse-probe failed:", err);
			exitCode = 1;
		})
		.finally(async () => {
			await cleanup(state.adminCookie, state.fixture, state.probes).catch((err) => {
				log(`  ! cleanup failed: ${err}`);
				log("    Remove the probe Work and close the report by hand before walking away.");
				exitCode = 1;
			});
			process.exit(filedNothing ? 1 : exitCode);
		});
}

// Only when this file IS the command. Importing it — which the tests do, to reach
// `probePlan` — must file nothing, decide nothing and exit nothing.
if (import.meta.main) run();
