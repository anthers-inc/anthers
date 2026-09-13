// SPDX-License-Identifier: Apache-2.0
/**
 * Which Anthers Lexicons resolve on the network — and therefore which collections Anthers may
 * write records into.
 *
 * 🚨 **A record is written only once its schema is published, and the reason is that a record is
 * the schema's first public commitment.** Publishing a Lexicon is irreversible and is reviewed
 * before it happens; a record shaped by an unreviewed draft skips that review by the back door.
 * It lands in a public repository, is broadcast to everyone listening the moment it does, and a
 * later change to the draft leaves it describing a shape the published schema never had —
 * deleting it afterwards broadcasts only the deletion. A draft that has written no records can
 * still be changed freely, which is the whole of what the review protects.
 *
 * ⚠️ **Only creating and replacing are withheld; removal never is.** Taking a record down is the
 * safe direction under every schema, and a gate that also blocked deletes would strand whatever
 * a local database or an earlier build had already written.
 *
 * ⭐ **Adding an NSID here is the step that follows publishing it**, and it is a code change on
 * purpose. The alternative — resolving `_lexicon.anthers.org` at write time — would make every
 * record depend on DNS and on somebody else's server answering, and would let a schema begin
 * being written to by being published rather than by anybody deciding it should be. What is
 * actually published can be read back off the network at any time:
 *
 *   dig +short TXT _lexicon.anthers.org        # the authority's DID
 *   curl "<its PDS>/xrpc/com.atproto.repo.listRecords?repo=<did>&collection=com.atproto.lexicon.schema"
 */

/**
 * The NSIDs published under anthers.org whose records Anthers writes.
 *
 * ⚠️ **The reader collections are published and deliberately absent.** `org.anthers.comment`,
 * `review`, `vote` and `follow` wait on reusing a hosted account's session across writes: the
 * reference PDS allows thirty new sessions in five minutes per account, a reader may cast thirty
 * votes a minute, and every write opens one today. They are added in the change that lands that.
 */
export const PUBLISHED_LEXICONS: ReadonlySet<string> = new Set([
	"org.anthers.work",
	"org.anthers.post",
	"org.anthers.project",
	"org.anthers.userPermissions",
	"org.anthers.creatorPermissions",
]);

let override: ReadonlySet<string> | undefined;

/** Whether records of this collection may be written. */
export function isLexiconPublished(nsid: string): boolean {
	return (override ?? PUBLISHED_LEXICONS).has(nsid);
}

/**
 * Pretend a different set is published, for a suite writing records into a throwaway server.
 *
 * ⚠️ **Test-only, and shaped like `setAtprotoClient` for the same reason**: the integration suites
 * exercise the production path end to end, and the gate is part of that path. Pass `undefined`
 * to restore the real set.
 */
export function setPublishedLexiconsForTesting(nsids: Iterable<string> | undefined): void {
	override = nsids === undefined ? undefined : new Set(nsids);
}
