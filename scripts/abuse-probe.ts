// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * ⚠️ **Admin is needed for exactly one thing — reading the escalation state back** over
 * `/api/admin/*`, which is operator information by design, since the report route
 * deliberately tells a reporter nothing about what happens next. Without it the report is
 * still filed; what is lost is the answer.
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
 *   bun run scripts/abuse-probe.ts --base https://anthers.org --admin-login you@example.com
 *
 *   --path      which single report to file: `public` (the no-account form, the default) or
 *               `in-app` (the authenticated route, which creates a Work and a comment to
 *               report and removes them afterwards).
 *   --wait      seconds to wait for the retry sweep before giving up (default 360; the
 *               cron runs every five minutes, so anything under 300 can report a false
 *               "never escalated").
 *
 * The password is asked for on the terminal. There is no flag for it.
 */

/** Which single report this run files. There is deliberately no way to ask for both. */
export type ProbePath = "public" | "in-app";

export interface ProbePlan {
	base: string;
	path: ProbePath;
	/**
	 * `/api/auth/sign-in` takes `{ login, password }` and resolves a username **or** an
	 * email against it, so this is a LOGIN rather than an email. Sending `{ email }` gets a
	 * 400 from the schema, which reads as bad credentials and is not.
	 */
	adminLogin?: string;
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

	const rawPath = get("path") ?? "public";
	if (rawPath !== "public" && rawPath !== "in-app") {
		return { refuse: `Unknown --path "${rawPath}". It is either "public" or "in-app".` };
	}

	return {
		base: (get("base") ?? "http://localhost:8000").replace(/\/+$/, ""),
		path: rawPath,
		// `--admin-email` stays accepted because it is the obvious thing to type.
		adminLogin: get("admin-login") ?? get("admin-email"),
		waitSeconds: Number(get("wait") ?? 360),
	};
}

/**
 * Read a password from the terminal without echoing it, and without keeping it anywhere.
 *
 * Raw mode rather than a readline interface, because readline echoes by default and the
 * usual way to stop it — overriding an internal write method — is a private API that has
 * broken before. Reading bytes is longer and does exactly one thing.
 */
async function promptHidden(label: string): Promise<string> {
	const stdin = process.stdin;
	process.stdout.write(label);
	stdin.setRawMode(true);
	stdin.resume();
	let entered = "";
	try {
		for await (const chunk of stdin) {
			for (const byte of chunk as Buffer) {
				if (byte === 3) {
					// Ctrl-C. Restore the terminal before leaving, or the shell is left in raw
					// mode with no echo and the next thing typed vanishes.
					process.stdout.write("\n");
					stdin.setRawMode(false);
					process.exit(130);
				}
				if (byte === 13 || byte === 10) {
					process.stdout.write("\n");
					return entered;
				}
				if (byte === 127 || byte === 8) {
					entered = entered.slice(0, -1);
					continue;
				}
				entered += String.fromCharCode(byte);
			}
		}
	} finally {
		stdin.setRawMode(false);
		stdin.pause();
	}
	return entered;
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

/**
 * Sign in as the operator, with a password that exists only as an argument.
 *
 * It is passed in rather than read off `args` so there is no field anywhere holding it —
 * the value is prompted for in `main`, handed here, and goes out of scope when this
 * returns. Nothing writes it to disk, to the environment, or to the log.
 */
async function signInAdmin(login: string, password: string): Promise<string | null> {
	const res = await call("/api/auth/sign-in", {
		method: "POST",
		body: JSON.stringify({ login, password }),
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

	// Asked for here and nowhere else. `signInAdmin` takes it as an argument so no field
	// holds it, and the readback is the only thing it is for — without an admin session the
	// report is still filed and only the answer is lost.
	let adminCookie: string | null = null;
	if (args.adminLogin) {
		const password = await promptHidden(`  password for ${args.adminLogin}: `);
		adminCookie = password ? await signInAdmin(args.adminLogin, password) : null;
	}
	state.adminCookie = adminCookie;
	if (adminCookie) log("  · signed in as admin — readback enabled");
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
		const publicRes = await call("/api/moderation/abuse-reports", {
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
		fixture = await createFixture();
		state.fixture = fixture;
		if (fixture) {
			log("Filing the in-app report…");
			// `csam` on purpose: it is the reason the form steers a real child-safety
			// reporter toward, and an escalation wired only to `illegal` would pass every
			// other test and miss the code the interface points the most serious report at.
			const inApp = await call("/api/moderation/reports", {
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
