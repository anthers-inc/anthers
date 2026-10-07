// SPDX-License-Identifier: Apache-2.0
//
// The public release notes — one entry per calver release, newest first, each written
// by the public-pass layer rather than copied from anything mechanical.
//
// ⏳ **This file is a way station, exactly like `roadmap.ts` beside it.** The settled
// direction (Parker, 2026-09-03) is that content moves into the public vault and reaches
// the site through the exporter, so **do not invest in the shape of this TypeScript
// module, and do not add a field the exporter would have to reproduce.** An entry is:
// a version, a date, a short prose lede, grouped bullets, and roadmap references.
//
// The two layers, and the boundary between them:
//
// - The **raw release notes** — every change between two tags, one line per squash
//   commit, exact and unedited — are generated at promote time and published as the
//   GitHub release on the tag (`scripts/release-notes.sh`). They are the audit trail.
//   **Never edit them to match this file, and never derive this file from them
//   mechanically** — the pass is a person's judgment, which is the point of having one.
// - **This module is that judgment's output**: the reader-facing entries, grouped into
//   arcs rather than commits, filtered of what a user cannot see (test machinery,
//   contributor tooling, internal rewrites), in Anthers' public voice.
//
// # The rules an entry has to follow
//
// 1. 🚨 **An entry names what a user or a creator can see, do, or be affected by.**
//    Contributor-facing mechanics are filtered on purpose: a release-notes page that
//    lists pre-push hooks trains a user to skim. Doubtful things go in with honest
//    scope, because silent omission is the page's failure mode — the raw list stays one
//    click away on the release.
// 2. **Group commits into arcs, one entry per arc.** The three Books tools are one
//    compliance story, not three rows. Order arcs by user weight, most consequential
//    first.
// 3. **Past tense, plain declarative.** The page's whole subject is the past, and it is
//    the one page where describing a shipped thing plainly is the honest mode. Nothing
//    here announces; an entry that sells is an entry to rewrite.
// 4. 🚨 **A roadmap reference is earned by shipping, not by adjacency.** `roadmapIds`
//    names the roadmap items this release moved to `launched`, and the page links each
//    entry to `/roadmap#goal-<id>` — the two-way link is the point of this page. Most
//    entries map to nothing, and that is correct: do not stretch an entry to claim one.
//    If a referenced item is still `active` or `planned` in `roadmap.ts`, that is a
//    defect — move the item in the same PR (its rules apply: one short sentence, and
//    `launched` carries a quarter).
// 5. **Money figures are interpolated, never typed** — `econ:figures --check` scans
//    this directory and a typed figure fails the build. If an entry must name a number
//    the model generates, the scenario lives in `packages/shared/src/scenarios.ts` and
//    the entry interpolates the constant.
// 6. **The voice is the vault's public voice** — `82.01 How Anthers Talks About Itself`
//    in `Anthers-Wiki/80-89 Development/82 Brand/` governs claims and vocabulary
//    (Work, Post, Library, Badge, gate, Public Access, Review, time). The pass is
//    captured as the `anthers-release-notes` skill, which walks the whole procedure.
//
// # Where an entry is written
//
// 🚨 **The entry rides the version bump's PR, before the promote.** `release-notes-audit.ts`
// runs as the first step of CI's deploy job and refuses a release whose version has no
// entry here, so a promote without its notes cannot deploy. `scripts/promote.ts` composes
// the new entry (and backfills any the audit finds missing — silently dropped releases are
// the page's failure mode) onto the bump branch, so the version, its entry, and its
// deployment all arrive together.

/**
 * One release. `lede` is the one-sentence frame under the version heading; each bullet
 * in `entries` is one arc, named by what it did for a user or a creator.
 */
export interface ReleaseNotesEntry {
	/** The calver version, matching the git tag the deploy job applies (`2026.10.0`). */
	version: string;
	/** The release date, ISO `YYYY-MM-DD`. */
	date: string;
	/** One short sentence framing the release. Not a summary of the bullets. */
	lede: string;
	/** One arc per bullet: what a user or creator can now do, see, or no longer hits. */
	entries: string[];
	/** `roadmap.ts` item ids this release shipped; rendered as links both ways. See rule 4. */
	roadmapIds?: string[];
}

/**
 * Every release, newest first. A new release lands at the top with its entry written by
 * the public-pass skill — never pasted from the GitHub release.
 */
export const RELEASE_NOTES: ReleaseNotesEntry[] = [
	{
		version: "2026.10.14",
		date: "2026-10-07",
		lede: "The emails keep their palette on a phone set to dark.",
		entries: [
			"Email from Anthers keeps the palette it was written in on a phone set to dark mode. The messages were written entirely in the light theme, and the mail clients that re-theme mail for a dark reader setting were washing them out; the messages now say so, and the clients that honor it leave them alone.",
		],
	},
	{
		version: "2026.10.13",
		date: "2026-10-07",
		lede: "Email receipts for every transaction, on both sides of a sale.",
		entries: [
			"Every purchase arrives with an itemized receipt: what was bought, the sales tax added on top, and the total the card was charged, one receipt per payment even when it covered several works. Refunds are receipted the same way, and a monthly support payment earns a receipt naming the creators it reached.",
			"Creators receive a copy of every sale and refund on their work, emailed to their account address. The emails are on by default while volume is low, and a switch on the Studio Settings page turns them off for a creator who has outgrown them.",
			"A transaction that predates receipts can have its receipt sent retroactively; the platform's first live purchase was receipted this way the day this shipped.",
		],
	},
	{
		version: "2026.10.12",
		date: "2026-10-07",
		lede: "A rename that settles what the record of shipping is called, and a basket card that reads like its creator.",
		entries: [
			"The changelog is the release notes now. The page and its address use what GitHub calls them, /release-notes, and the old /changelog address redirects there with its deep links intact. The name was chosen because changelog and changelist sounded too much alike to keep apart; the raw, unedited list of every commit still lives on each version's GitHub release, one click from every entry.",
			"A release's notes are now part of shipping it: a release whose notes are missing cannot deploy, and the notes of the two releases this one follows, 2026.10.10 and 2026.10.11, arrive with this one as backfill.",
			"The basket's items sit under the card of the creator they belong to, so a basket holding works from several creators reads as one group per creator rather than one undivided list.",
		],
	},
	{
		version: "2026.10.11",
		date: "2026-10-07",
		roadmapIds: ["observability"],
		lede: "The release that can say something broke: a status page, an error tracker, and limits on the doors that had none.",
		entries: [
			"A public status page at /status answers what is working right now: the site, the API, the database, storage, and email, with links to the release notes and the roadmap, so an outage question has a place to be answered without asking anybody.",
			"Errors the site itself hits are captured now. A browser beacon hands a failure to the server, which records it, redacts anything that looks like a credential, folds duplicates together, and raises an alert when the same error keeps happening. Before this, finding out meant somebody thinking to read logs.",
			"Every open door (signup, sign-in, uploads, and the public reads) runs behind a shared rate limit, so traffic that arrives in bulk is slowed by itself rather than taking the platform with it.",
			"The health endpoint tells the whole story: each dependency's state alongside the deploy's commit and version, and the server reports its own heartbeat, so a machine that stops reporting is a fact somebody sees rather than an absence nobody notices.",
			"Creators hosting browser builds got the serving half of the cloud-save design: a hosted build's saves round-trip through Anthers' storage, and threaded builds play on an isolation page so a thread's workers cannot collide with the page that opened them.",
			"The Work Edit page uses its width, and the dates a Work carries sit together instead of scattered.",
		],
	},
	{
		version: "2026.10.10",
		date: "2026-10-05",
		lede: "Getting paid, and the machinery that reads its own state honestly.",
		entries: [
			"The Studio's Payments tab is where a creator sets up payouts: connecting a Stripe account, seeing what Anthers holds and what has settled, and reading the ledger of what moved. Every newly connected account's payouts start on a manual schedule, so money arrives on a person's review rather than on a default nobody chose.",
			"Connected-account flags reconcile from Stripe on every read, so a webhook that arrives late, or never, cannot leave onboarding stranded half-finished.",
			"The locked preview and the purchase panel sit together on a Work page, so a buyer sees what they are buying and how to buy it without the page hiding one behind the other.",
			"Every dollar figure the site quotes is read from the ladder rows the database holds, rather than from copy that could drift from what the checkout actually charges.",
			"Issue reports have a public intake at /issues, separate from the statutory paths: a page, a database table, and a queue in the admin console, for when the site itself misbehaves.",
			"A post's content is stored as markdown rather than HTML, so what the editor wrote is what is stored, and rendering decides presentation.",
			"Checkout kept its form, gained a split receipt, opens the address step by default, and takes cards only, matching how the account's payment methods are narrowed.",
			"Operators got three tools for corrections: an ATProto drift report with re-sync, the ability to correct a Work's listing, and a ladder-rows surface that serves the copy the site reads.",
		],
	},
	{
		version: "2026.10.9",
		date: "2026-10-04",
		lede: "Housekeeping in the open, most of it where a visitor will never meet it.",
		entries: [
			"The copy spells nonprofit as one word, the way Anthers' style guide already said it; a handful of pages still carried the hyphen.",
			"Operators reading a failed job in the admin console can expand and copy its full error text, rather than squint at a truncated line.",
			"The billing layer stopped treating Anthers' own creator account as a special case: it is an ordinary issuer now, collected and paid like any other creator's.",
		],
	},
	{
		version: "2026.10.8",
		date: "2026-10-04",
		lede: "Found the hard way, in the middle of a real purchase: a basket belongs to the buyer, not the browser.",
		entries: [
			"A basket follows the account that holds it rather than the browser it was built in. A second account signing in on the same computer no longer inherits the first account's pending purchase; the basket lives on Anthers' server now, scoped to the account. A signed-out browser's scratch basket still works, and it merges into the account at sign-in, after which the browser holds nothing.",
		],
	},
	{
		version: "2026.10.7",
		date: "2026-10-04",
		lede: "The basket's checkout met its first real use, and this release is what that use turned up.",
		entries: [
			"The basket's checkout no longer starts itself over while a buyer is filling it, which used to wipe the card and address mid-fill along with any tax it had already worked out. Only a genuine change to what the basket holds starts it over now.",
			"Sales tax on the basket fills itself in from the billing address. The calculate-tax button is gone: a complete address resolves the receipt's tax and total on its own, a half-typed one does nothing, and the only button left on the checkout is the one that pays.",
			"The basket page is two columns now: what is being bought and its receipt on one side, the address and card that pay for them on the other. On a phone they stack to one column: items, receipt, checkout.",
		],
	},
	{
		version: "2026.10.6",
		date: "2026-10-03",
		lede: "The purchase funnel found its shape: everything goes through the basket.",
		entries: [
			"Every purchase goes through the basket. A Work page's own checkout form is retired, so buying runs one consistent flow with the receipt on it, wherever the purchase starts.",
			"Beneath that, the billing half of an account split from its preferences, groundwork for the Badge model that stores what somebody supports rather than recomputing it.",
		],
	},
	{
		version: "2026.10.5",
		date: "2026-10-03",
		lede: "One button said more than checkout did.",
		entries: [
			"The address step's button is named for what it does now: it calculates sales tax from the address typed. It never saved the address, and the old label implied that it did.",
		],
	},
	{
		version: "2026.10.4",
		date: "2026-10-03",
		lede: "Two fixes, both to doors a buyer walks through.",
		entries: [
			"A checkout could read its total out of Stripe's currency-formatted amount string and quote a charge of NaN dollars at the buyer. Totals are read from the raw unit figure now, so the number on the receipt is the number the bank sees.",
			"The login field takes a Bluesky handle now, routed through the Bluesky flow, where it previously insisted on an email address.",
		],
	},
	{
		version: "2026.10.3",
		date: "2026-10-03",
		lede: "A quiet release: the release notes learned to group by month, and the Badge model landed.",
		entries: [
			"The release notes group by month, with each numbered release named on a divider inside it, so a month's releases read together.",
			"The Badge model landed in the database: a level of support somebody gives a creator, set in dollars at any amount, stored rather than recomputed from giving history.",
		],
	},
	{
		version: "2026.10.2",
		date: "2026-10-03",
		lede: "The month creators were paid, and the machinery that keeps money that comes back honest.",
		entries: [
			"Creators were paid for the first time. Settled earnings move to a creator's own Stripe account after a fourteen-day hold, and the Studio's Earnings panel shows what is held and what has moved.",
			"A payment dispute can be contested deliberately rather than only recorded: evidence is assembled from what Anthers honestly holds, the submission names its stakes before it happens, and money that comes back to a buyer after a creator was paid is netted against that creator's next payout, floored at zero and never billed.",
			"Signup copy leads with what is free: no card, no trial, nothing to cancel. Pages that described an account as an email address and a handle now say what signing up actually is: an identity, or a Bluesky account brought along.",
			"Every dispute is recorded, and the ones that need a person are flagged, where before only the exceptional ones stood out.",
			"The automated-test account is invisible on every public listing, so one fixture stops turning up where a real user can meet it.",
			"The footer gained a Development column and a calmer layout, and the navbar's logo gave up its hover chrome.",
		],
	},
	{
		version: "2026.10.1",
		date: "2026-10-02",
		lede: "The pre-launch gate came down, and signing up is open to everyone.",
		entries: [
			"The site's password gate is gone, and Anthers opens freely to signups. The door keeps bots out without a third-party captcha in the funnel: the browser solves a short proof-of-work on submit, a second or so, and proves nothing to anybody but Anthers.",
			"The signup page is /signup now; the old /subscribe address redirects there, and nothing in the flow calls itself a subscription, because nothing on Anthers is one.",
			"The public reporting page lives at /abuse, and it stopped describing itself as only for illegal content. A person reporting spam or harassment without an account could already use that form, and the page now says so.",
			"Reports of a security issue have a dedicated security@anthers.org address, stated where a researcher would look for it.",
			"The release notes exist, and every release's full commit list is published on the tag it shipped under, generated by the deploy job itself.",
		],
	},
	{
		version: "2026.10.0",
		date: "2026-10-02",
		lede: "The changes that landed between opening the release notes and the first calver tag.",
		entries: [
			"An emailed code is now the only way to sign in. No account holds a password, and nothing accepts one — sign-in, recovery and verification all run through the code Anthers emails.",
			"A profile's address is its handle. The separate Anthers username is gone, so a person is found at the handle they already own — an Anthers one, or a Bluesky one they brought — and a handle that changes keeps routing for ninety days while it settles.",
			"Comics open in a reader made for them. Panels are detected on each page and you can walk them one at a time, with the detection correctable page by page in the Studio.",
			"Spoken audio plays in a player made for talk: skip back and forward, a listening speed that carries across works, and a place to resume. A video can be listened to the same way, as a podcast.",
			"The Library gained a video lens beside the music one, and the music lens learned to include spoken word when you ask for it.",
			"Reviews sort by helpfulness first, with the newest order still available. The recommended share can be read over all time or over a recent window, so a Work that changed after release can be seen to have changed its users' minds.",
			"An embed is a share link in a second shape. The Share button offers Link or Embed as peers, and the embed renders the same player through the same rules — a gated Work stays gated.",
			"Every charge now collects the sales tax it actually owes, in every state, replacing a flat illustrative rate — and the Books tools assemble what each jurisdiction is owed into a worksheet a person can review and file.",
			"Account suspension exists as a moderation action: recorded, reversible, and handled from a screen in the admin console alongside the earnings review it can require. A suspended account's works and posts go dark, its buyers keep their purchases, and money already owed holds for a bounded review rather than vanishing.",
			"Work credits are confirmed by the person they name. A credit is stored and published on the Work's record, and an identity credit a contributor has not accepted reaches only them and the Work's creator — never a stranger, and never as a bare DID.",
			"A Work now carries its original release date — when it first came out anywhere, not when it reached Anthers — and the catalog can sort by it.",
			"Account settings broke into four tabs: Account, Identity & Devices, Content & Safety, and Activity & Data.",
			"A rated Work's cover is covered on the Library shelf as it is everywhere else, so a kind of content a user blurs stays blurred in their own library.",
			"The safety page's scan disclosure now names video alongside images, matching what the scan actually covers.",
			"Anthers started numbering its releases, and the number is visible in the logged-in footer — this entry is about the first one.",
		],
	},
];
