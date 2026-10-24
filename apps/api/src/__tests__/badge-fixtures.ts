// SPDX-License-Identifier: Apache-2.0
/**
 * A creator's Badge rung, for suites whose subject is something other than the ladder.
 *
 * A Work's gate must name one of its creator's rungs (`normalizeAccessRows` in
 * `services/access.ts`), so a suite that gates a Work at $2 needs a $2 rung to point at.
 * Creating it through the real route keeps the fixture honest about what the product
 * accepts, and `purgeAccountsCreatedHere` takes it with the account.
 */
import app from "../index";

const ORIGIN = "http://localhost:3000";

export async function createBadgeRung(
	cookie: string,
	threshold: string,
	label = "Test Badge",
): Promise<number> {
	const res = await app.fetch(
		new Request("http://localhost/api/subscriptions/badges", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ threshold, label }),
		}),
	);
	if (!res.ok) throw new Error(`could not create a Badge rung: ${res.status}`);
	const body = (await res.json()) as { badge: { id: number } };
	return body.badge.id;
}
