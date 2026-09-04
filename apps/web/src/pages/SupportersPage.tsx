// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Everybody who has ever supported Anthers, thanked by name.
 *
 * ⭐ **Names, never amounts** (Parker, 2026-09-04). Supporters are grouped by lifetime total
 * and ordered alphabetically inside each group, so the page has a shape without publishing a
 * figure about anybody's finances. The grouping is the server's — `@anthers/shared/
 * supporters` carries why a group is never small enough to identify one person's bracket.
 *
 * ⚠️ **The groups are deliberately UNLABELED and unnumbered.** Naming them would invent a
 * vocabulary of standing Anthers has not decided on, and it would collide with Badges, which
 * are a monthly level rather than a lifetime one. Order carries the meaning; if a reader
 * cannot tell which group is which, that is the page working.
 */

import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

interface Supporter {
	username: string;
	displayName: string | null;
}

export default function SupportersPage() {
	const [groups, setGroups] = useState<Supporter[][] | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		client.api.subscriptions.supporters
			.$get()
			.then(async (res) => {
				if (!res.ok) throw new Error(String(res.status));
				setGroups(((await res.json()) as { groups: Supporter[][] }).groups);
			})
			.catch(() => setFailed(true));
	}, []);

	const total = groups?.reduce((n, g) => n + g.length, 0) ?? 0;

	return (
		<div className="mx-auto max-w-3xl px-4 py-12">
			<h1 className="font-serif text-3xl font-medium">Thank You</h1>
			<p className="mt-3 text-base-content/70">
				These are the people who have supported Anthers — everyone who ever has, whether they still
				do or not. Half of what each of them gives goes to creators; the rest keeps the commons free
				and pays for the programs.
			</p>
			{/* Says what the page does NOT publish, because a page ordered by money invites the
			    question and answering it is cheaper than leaving somebody to wonder. */}
			<p className="mt-2 text-sm text-base-content/45">
				Grouped by how much each person has given in total, and listed alphabetically within each
				group. No amounts are shown, and nobody is listed who has asked not to be —{" "}
				<Link to="/settings" className="link link-hover">
					that is a setting on your account
				</Link>
				.
			</p>

			{failed && (
				<p className="mt-10 text-base-content/50">
					This list could not be loaded just now. It is a page of names, so nothing is lost by
					trying again in a moment.
				</p>
			)}

			{groups && total === 0 && (
				// ⚠️ Not an error, and it must not read as one. Anthers is pre-launch; an empty
				// page here is the honest state of a young platform rather than a failure.
				<p className="mt-10 text-base-content/50">
					Nobody is listed yet. Anthers has not opened to the public, so this page is waiting for
					its first names.
				</p>
			)}

			{groups?.map((group, i) => (
				<section
					// Position is the only identity a group has — they are unlabeled on purpose —
					// and the list is regenerated whole on every load, so it cannot reorder under a
					// stable key.
					// biome-ignore lint/suspicious/noArrayIndexKey: groups are positional by design
					key={i}
					className="mt-10"
				>
					<ul className="flex flex-wrap gap-x-6 gap-y-2">
						{group.map((person) => (
							<li key={person.username || person.displayName} className="text-base-content/80">
								{person.displayName || person.username}
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
