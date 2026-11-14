// SPDX-License-Identifier: Apache-2.0
/**
 * How a Work's owner set reads in a byline.
 *
 * A solo Work is the publisher's name; a Collab Work is every owner's, joined the way a
 * sentence joins people. The publisher leads because the server returns the set in that
 * order, and the display treats them equally after that.
 */
export interface OwnerName {
	handle: string;
	displayName: string | null;
}

/** One owner's name, or their handle when they have not set one. */
export function ownerName(owner: OwnerName): string {
	return owner.displayName || `@${owner.handle}`;
}

/** The whole set, "A and B" or "A, B, and C"; "this creator" when the set is absent. */
export function ownerNames(owners: readonly OwnerName[] | undefined): string {
	if (!owners || owners.length === 0) return "this creator";
	const names = owners.map(ownerName);
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** True when the Work has more than one owner — the combo avatar's condition. */
export function hasSeveralOwners(owners: readonly unknown[] | undefined): boolean {
	return (owners?.length ?? 0) > 1;
}
