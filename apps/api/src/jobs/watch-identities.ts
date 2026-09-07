// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Watch the identity documents of accounts Anthers hosts, and shout when one moves.
 *
 * 🚨 **There is a 72-hour clock on the remedy, and it starts silently.** A rotation key
 * ranked above the one that signed a hostile operation can undo it — but only inside that
 * window, after which the operation is permanent. So an account holder's recovery key
 * protects them only if somebody notices in time to use it, and until this job existed
 * nothing told anybody the clock had started.
 *
 * ⭐ **It runs in the hub's worker on purpose.** The natural place to put this is beside
 * the Personal Data Server, and that is the one place it must not go: an attacker who can
 * sign operations on that machine can also stop the process that would report them. The
 * hub is separate infrastructure with its own database, which is what makes the alarm
 * survive the event it describes. Same reasoning as keeping a backup copy the node holds
 * no credential for.
 *
 * ⚠️ **The watch list only ever grows.** It is fed by asking the server which repositories
 * it holds, and a compromised server could simply stop listing one — so a DID seen once is
 * watched forever, and a row that stops appearing in a listing *that otherwise succeeded*
 * is itself an alert. Removing a row is a person's deliberate act, never something the
 * watched server can cause.
 */
import { db } from "@anthers/db";
import { hostedIdentities } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { escapeHtml, sendOperationalAlert } from "../services/email.js";
import {
	assessIdentity,
	type IdentityFinding,
	isAlertable,
	listHostedRepos,
	readIdentityHead,
} from "../services/hosted-identity.js";

export interface WatchResult {
	checked: number;
	alerts: number;
	findings: IdentityFinding[];
}

/**
 * One sweep.
 *
 * Returns rather than logs, so the worker decides what is worth a line and the tests can
 * assert on outcomes instead of scraping stdout.
 */
export async function watchHostedIdentities(): Promise<WatchResult> {
	const pdsUrl = process.env.HOSTED_PDS_URL?.trim();

	// The listing is what discovers new accounts; the stored rows are what keeps old ones
	// watched. A deployment with no server of its own still watches whatever it already
	// knows, which is the correct behavior if the variable is ever unset by accident.
	const listed = pdsUrl ? await listHostedRepos(pdsUrl) : null;
	const known = await db
		.select({
			did: hostedIdentities.did,
			headCid: hostedIdentities.headCid,
			handle: hostedIdentities.handle,
			pdsEndpoint: hostedIdentities.pdsEndpoint,
		})
		.from(hostedIdentities);

	const storedByDid = new Map(known.map((r) => [r.did, r]));
	const dids = new Set<string>([...storedByDid.keys(), ...(listed ?? [])]);

	const findings: IdentityFinding[] = [];
	let alerts = 0;
	const now = new Date();

	for (const did of dids) {
		const stored = storedByDid.get(did) ?? null;
		const observed = await readIdentityHead(did);
		const wasListed = listed === null ? null : listed.includes(did);

		const forThisDid = assessIdentity({ did, stored, observed, listed: wasListed });
		findings.push(...forThisDid);

		// A row is only ever written from a successful read. An unreadable directory must
		// not blank the last known good value — that would turn one outage into a "changed"
		// finding on the following run, which is a false alarm manufactured by the watcher.
		if (observed !== null) {
			const row = {
				did,
				handle: observed.handle,
				pdsEndpoint: observed.pdsEndpoint,
				headCid: observed.headCid,
				lastCheckedAt: now,
			};
			if (stored === null) {
				await db.insert(hostedIdentities).values(row).onConflictDoNothing();
			} else {
				await db.update(hostedIdentities).set(row).where(eq(hostedIdentities.did, did));
			}
		}

		// Only a listing that succeeded is evidence the server still holds this.
		if (wasListed === true) {
			await db
				.update(hostedIdentities)
				.set({ lastListedAt: now })
				.where(eq(hostedIdentities.did, did));
		}

		for (const finding of forThisDid) {
			if (!isAlertable(finding)) continue;
			await sendOperationalAlert(describeFinding(finding));
			await db
				.update(hostedIdentities)
				.set({ alertedAt: now })
				.where(eq(hostedIdentities.did, did));
			alerts++;
		}
	}

	return { checked: dids.size, alerts, findings };
}

/**
 * Turn a finding into something a person can act on in the ninety seconds they will give it.
 *
 * The subject carries the whole point, because that is all a phone shows: a changed identity
 * is a three-day fuse and the mail has to say so before it is opened.
 */
export function describeFinding(finding: IdentityFinding): { subject: string; html: string } {
	if (finding.kind === "vanished") {
		return {
			subject: `[Anthers] identity no longer listed by its server — ${finding.did}`,
			html:
				`<p>The Personal Data Server answered a repository listing and <strong>did not include ` +
				`${escapeHtml(finding.did)}</strong>, which it has held before.</p>` +
				`<p>The listing succeeded, so this is not an outage. Either the account was removed ` +
				`deliberately, or somebody is hiding it.</p>`,
		};
	}
	if (finding.kind !== "changed") {
		// Only alertable findings reach here; this keeps the function total rather than
		// letting a new finding kind silently produce an empty message.
		return {
			subject: `[Anthers] identity finding — ${finding.did}`,
			html: `<p>${finding.kind}</p>`,
		};
	}
	return {
		subject: `[Anthers] identity document CHANGED — ${finding.did} — 72 hours to undo`,
		html:
			`<p>The identity document for <strong>${escapeHtml(finding.did)}</strong> has a new operation.</p>` +
			`<p><strong>A higher-ranked rotation key can undo this, but only within 72 hours of it ` +
			`being signed.</strong> After that it is permanent. If this change was not made by you ` +
			`or on your instruction, act now rather than after reading the rest of this mail.</p>` +
			`<ul>` +
			`<li>handle: ${escapeHtml(finding.handleFrom ?? "—")} &rarr; ${escapeHtml(finding.handleTo ?? "—")}</li>` +
			`<li>server: ${escapeHtml(finding.endpointFrom ?? "—")} &rarr; ${escapeHtml(finding.endpointTo ?? "—")}</li>` +
			`<li>operation: ${escapeHtml(finding.from ?? "—")} &rarr; ${escapeHtml(finding.to)}</li>` +
			`</ul>` +
			`<p>The full history is at ` +
			`https://plc.directory/${encodeURIComponent(finding.did)}/log/audit</p>`,
	};
}
