// SPDX-License-Identifier: Apache-2.0
//
// The public release notes — one entry per calver release, newest first, each written
// by the public-pass layer rather than copied from anything mechanical.
//
// ⏳ **This file is a way station.** The settled direction (Parker, 2026-09-03) is that
// content moves into the public vault and reaches the site through the exporter, so
// **do not invest in the shape of this TypeScript module, and do not add a field the
// exporter would have to reproduce.** An entry is: a version, a date, a short prose
// lede, and grouped bullets.
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
// 4. **Money figures are interpolated, never typed.** If an entry must name a number the
//    model derives, the scenario lives in `packages/shared/src/scenarios.ts` and the entry
//    interpolates the constant, so a dial that moves updates the note with it.
// 5. **The voice is the vault's public voice** — `82.01 How Anthers Talks About Itself`
//    in `wiki-anthers/80-89 Development/82 Brand/` governs claims and vocabulary
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
}

/**
 * Every release, newest first. A new release lands at the top with its entry written by
 * the public-pass skill — never pasted from the GitHub release.
 */
export const RELEASE_NOTES: ReleaseNotesEntry[] = [
	{
		version: "2026.10.31",
		date: "2026-10-24",
		lede: "An account can export its identity and carry it to another server, a Work's media became something with versions, and Discovery's recipe became three choices a user makes.",
		entries: [
			"An account can download its identity as one bundle now: the public repository, every space with its records and blobs, and the JSON Anthers keeps. A deletion asks for a bundle taken in the last seven days, names the last one taken, and proceeds once somebody downloads one or deliberately chooses to delete without it.",
			"The Identity tab names the server holding an account's identity, links its account page where one exists, and says when Anthers is the host. It lists what Anthers writes and offers disconnecting the app, which takes the listings down and ends every write until permission returns. An identity can move to another server, an operator's step that verifies the copy before the old one is retired.",
			"A purchase writes a signed receipt into the buyer's own space: the Work's public id, title, and kind, both DIDs, the date, and the processor's transaction id, and no amount, fee, tax, or payment method. A refund is a second record naming the receipt it follows, and the receipt itself is never edited. A download carries a ten-minute grant for its one file, and a refund stops the next grant.",
			"An account can connect to Discord from either settings page, and Anthers keeps two roles there in step: User for every account, Creator once it has released a Work. A daily sweep reconciles both directions, deleting an account takes its roles with it, and the Privacy Policy names the Discord user ID Anthers stores.",
			"A gated Work's manifest lives in a space the creator's own server holds, and Anthers answers that server's gate as a managing app. A user reads the manifest with a short-lived credential bound to the request, and the answer's MAC is verified before its file list is believed.",
			"New Work is four cards now: name, category, type, and delivery. Choosing a type creates the private draft, nothing uploads during the flow, and the Work's page carries every way to add media. A replaced Work keeps its earlier media as a version its creator can download or remove, dated when it was added, and a released Work gains a new version the same way.",
			"A Work carries one Release Date now, where a checkbox and a scheduled time used to answer the same question. Empty keeps it private, a time already passed releases it now, and the Now button fills that time; a future time schedules it. Both date fields explain themselves behind an (i) beside the label.",
			"A Work's gate names one of its creator's Badge rungs now, and the amount follows that rung. Repricing a rung moves every gate on it in the same transaction, and deleting a rung a Work still gates on is refused rather than leaving a door with nothing behind it.",
			"A contribution with several people is one card in the credits editor now, carrying its role and type over a list of contributors and reading as one row per person on the Work page. A creator naming themselves accepts that credit when the Work is written, and a contributor with no network identity keeps a neutral circle rather than a gap.",
			"A creator's profile has a Credits tab that reads out every published Work naming the account, grouped by role and linked with its year. The account also sees the credits it has not confirmed there, with the Accept and Decline controls the Work page carries, so reviewing an attribution no longer means finding each Work.",
			"Accepting credit for a Work asks publishing permission before anything is recorded, so a refusal leaves no row behind and a later attempt can still succeed. A creator whose scheduled post loses that permission is told it did not go out, once per schedule.",
			"Badges and Purchases are one page in Settings now, and the Badges tab is a card grid: each card carries the mark, name, monthly amount, and description, with the rung a user holds and the one they picked marked. A creator's cards open the Badge Maker in a dialog, and a new Add a Badge card sits in the grid.",
			"The User and Creator switch moved into the header beside the logo, and the user sidebar gained Settings and lost its own switch. A creator's Dashboard is the first tab on their own profile, and /studio leads there too. Log Out is a card at the top of the Account tab on both settings pages, and the Library now shares Network's page shell.",
			"Discovery is one stream now, with a recipe bar that sets it: From picks the candidates, Order picks the mix, and Window narrows what came back, and all three ride the URL. The old Modes and presets are gone, so a stale link to one lands on the stream, and each card says why it is there.",
			"The Music Player, Bookshelf, and Channel Guide lenses read every user tab now, not just the Library. Discovery runs all three over its one stream, and the rows a lens does not draw gray out rather than narrowing the feed it reads.",
			"A shared Work, post, and profile each preview as itself now, with its own title, description, and image, and each names its own page as the canonical address. A share link is treated as a locator rather than a page, so it points at the Work it opens, and an unresolvable link still shows the site card.",
			"The note that says who shared a Work is a paper-airplane control on the media now: on an embed it opens only under the pointer, and on a share link it opens on arrival and closes after thirty seconds or on the first interaction. The share sheet names its shapes Share Link and Embed Code, and two links minted at once both succeed.",
			"The 1200×630 share card is a crop of the light 16:9 banner now, so its wordmark, spray, and bee stay whole and the frame carries no black padding where a transparent corner used to be.",
			"Every standing page has its own title, description, and canonical address in the head now, so a pasted policy or marketing link no longer claims to be the homepage. robots.txt states what crawlers may read, and sitemap.xml lists the standing pages. The catalog stays out of the sitemap, because a listing there could publish an existence a Work's rating withholds.",
			"A Work's media gained a theater mode beside full screen that takes the content column's width and leaves the page in flow, carried by the video player, comic reader, and ebook reader. Full screen and theater join the search bar's chords as the account's own rebindable keys, and the sidebar's toggle is Ctrl+/ by default.",
			"A post's grid tile picks its thumbnail through the same allow-list a title's mention uses now, so an Adult Work's cover stays out of a post shown to somebody whose rating hides the Work. A user who has opted in and verified still sees it.",
			"Follow, Block, and Report sit on the line with a creator's handle and follower count now. Follower notifications open the profile they name, a suspension notice no longer links to a page that never existed, and the comment and review links land on the tab they name. Activity lines say who did what, the feed groups by day and holds its order, and the bell is drawn only when it has a count.",
			"The app's own roadmap page is gone, and the wiki roadmap is the only one. The release notes head each release with its version and its date spelled out, and the shipped-goal chips went with the page they pointed at.",
		],
	},
	{
		version: "2026.10.30",
		date: "2026-10-21",
		lede: "Guided view became a per-page choice for a comic's creator, the Creator Terms state the credits policy, and the feed's music and book lenses went live.",
		entries: [
			"Guided view is a per-page setting on a comic now, off by default: a page with it off shows no detected regions, asks for nothing, and reads whole to every reader. Turning it on shows that page's proposals and the controls that define them, and only an enabled page can require its panels. Releasing never waited on a confirmation and still does not, and a creator's preview now matches a reader's.",
			"The Creator Terms state the credits policy now: every Work a creator releases carries credits, at least one has to name a human, Created and Generated are defined, and a false credit is the violation. The terms also say Anthers does not run AI detection.",
			"The Music Player and Bookshelf lenses read the Network feed now. A track arriving there groups under the Project it was released on, and the lens opens that record whole with its own track count, while the rows a lens does not draw gray out rather than narrowing the feed it reads. The Channel Guide stays grayed on the feed, because its programs play inline and a feed entry has nothing to play.",
			"The Channel Guide draws itself like a schedule now: fixed-height channel bugs at the top, program blocks aligned row for row, and a rank ruler down the left naming positions from the newest. The playing view carries that ruler into its rail, marking the row above the current one Up next, and the up-next control became a directional pill that names the next program or says that nothing sits above.",
			"A Work's owner sees the page and section counts its readers see now: a comic a creator opened no longer says the book has no pages yet, and an ebook owner is sent to the reflow reader rather than the page one.",
			"The sidebar's Library, Network, and Discovery rows keep one order now, and the drag-to-reorder control is gone. A session opens on a starting tab instead, an account setting that defaults to Network and is chosen from a Where You Start card in Settings; an account that had rearranged its tabs lands on the tab it had put first, and the desktop app opens its user side on that tab.",
			"The player bar enters and leaves rather than appearing in one frame, and the page's bottom padding moves on the same duration, so pressing play no longer shifts the content under the pointer. A track change cross-fades the cover and lifts the title and creator a few pixels, the queue and lyrics panels enter and leave the same way, and a bar on its way out still shows what it was playing.",
			"The share sheets, the post page's confirmations, the profile block confirmation, and the three Studio delete dialogs rise a few pixels, settle, and stay through their overlay's fade, keeping the name of what is going away on the box until it is gone.",
			"Every transition and animation follows the system's reduced-motion setting now, landing on its final state including any added later, and a loading spinner keeps turning at a slower rate because a frozen one reads as broken.",
			"A Bookshelf spine's tooltip stops inventing a page where a listing carries no page count.",
			"A keycap carries its own ink now, so a chord inside a button stays legible; Ctrl+K on the active search toggle had been there and unreadable against the button's label color.",
		],
	},
	{
		version: "2026.10.29",
		date: "2026-10-20",
		lede: "The signed-in site reorganized around three tabs and one search box, and the Work page took one media shape whatever the Work holds.",
		entries: [
			"The signed-in site's first three tabs are Library, Network, and Discovery now, each with one header and its own arrangement. Library keeps its lenses over what was saved or bought, Network gathers the feed, and Discovery leads with people and the whole site rather than the projects Browse listed.",
			"Network gained a Membership section that widens the feed to creators supported or to the creators behind anything saved or purchased, and Discovery carries the same Modes and Lenses arrangement, with Graph ranking creators by how many of the people a user follows also follow them and Ticker running the whole site's newest entries. Each mode names its formula and parameters above the content.",
			"The addresses moved with the names, /feed to /network and /discover to /discovery, and the signed-in sidebar collapses to a rail of icons on a desktop, keeping Network, Library, and the Studio's places one click away while the page takes the width back. Each icon keeps its label as its accessible name and hover title.",
			"Search lives in the topbar as one control with two modes now. Search opens on Ctrl+K and looks across Creators, Works, Projects, and Posts, taking names and titles first and reaching bios, descriptions, and Post bodies only when that comes up short, with the account's own work, anything in its Library, and the people it follows ranking ahead of the rest.",
			"Filter opens on Ctrl+F and narrows the view on screen without leaving it, reading the query the Library and the feed already understand. Both shortcuts are an account setting with those defaults, and a rebound Filter gives the browser's own find back.",
			"The Music lens reads a shelf as releases and tracks now: a saved Project holding music is a release, a saved music Work with no Project is a one-track release, and saved tracks group under the Project they came from. Opening a release turns the grid into the album view with its tracks and transport, where a Project saved directly opens whole and one reached through saved tracks opens those.",
			"A shared Work link unfurls as the Work now: the web origin answers /works addresses with the Work's own title, description, and thumbnail in place of the site's static card, so a link to a game, a track, or a book says which one it is before it is opened. The site card answers wherever the Work's card cannot, including a Work this user may not see.",
			"The Upload page reads as the kind that was picked now: the card under the picker states that kind's facts, whether the video set and cap, audio conversion, the image gallery, a comic's page images, a book's EPUB and PDF rules, or each platform's build format. A comic takes JPG or PNG page images, and a new PDF is refused there.",
			"Choosing Web swaps the one-file picker for an engine export's folder or a zip of it, with the entry file and threaded posture answered before the build row exists, and the upload carries on to the Work's page where Hosted Build reports it.",
			"A comic publishes without panel work now: panel detection proposes only to the Work's owner, every other caller gets the pages a creator confirmed, and a Work with nothing confirmed reads as whole pages with no panel mode, turning a page at a time as guidance is added. The Studio says plainly that confirming panels is optional.",
			"The Work page's media area is one 16:9 stage for every kind now, so the card never grows with what it holds: an image pillarboxes or letterboxes inside it, a comic and a book take its full height, writing scrolls in its own measure, and the video player fills it as a column without clipping its chapters or its meter.",
			"The Details tab leads with the description and puts the release below it, the rating tab moved its boundary note behind an information icon, and a shared creator card carries a thumbnail, name, bio, and follow control across Showings, the Creators listing, and Discovery. Audio's Manage tab gained video's Media Status card, and a centered Work title keeps its pencil in the right gutter.",
			"A Project can wear one of its Works as its cover: the Project points at a Work on its shelf and reads that Work's current cover, so changing the Work's cover changes the Project's, and a chosen Work that is hidden, off the shelf, or deleted leaves the Project on its uploaded image. The Project's two description fields are one, the tagline gone.",
			"A Project's shelf order is the creator's choice and the page serves it now, with Manual, Release Date, Original Release Date, and Alphabetical saved on the Project along with direction, so the public page, the owner's shelves, and an album's queue agree. Manual remains the only order the grips change.",
			"A Post's title can name a Work with @ now, and every surface renders the Work's current name from the id the mention stores, so a retitle reaches titles written before it. A mention of a Work this user may not see falls back to plain text and never links, and a Work's Showings tab lists the published Posts whose titles name it.",
			"The Post page's controls gathered into a Work page's shapes: Share and Save at the right end of the reaction row, with Save putting the Post in the Library beside Works and Projects, the edit history in a modal that no longer shifts the page, and one owner pack at the title for Publish, Unpublish, Pin, and Unpin. Bookmarks moved into the shelf, and Show on the timeline left end to end.",
			"A gated video or game Work carries a storefront now: screenshots and a trailer sit under the price or unlock card, with side chevrons and a thumbnail strip, so a user can see what stands behind a gate before deciding. A Work with no preview set renders the page it rendered before.",
			"A creator tags a Work from its Details tab now, up to five tags, chosen from the tags released Works already carry with a count beside each or typed as a new one. The feed, Library, and Discover filters read the same tags, and a visitor's read view shows them beside the description.",
			"A Review's text is optional now: a verdict alone counts in the Work's recommended share and its Recent share, the reviews list shows only the ones with writing, and an empty state distinguishes no reviews from no written reviews.",
			"A basket survives opening it now: the stored basket was cleared the moment a checkout session existed, so opening the basket and walking away erased it and emptied the header badge. It now clears only the items a completed charge carried, resumes an unchanged basket's open session rather than starting a second, and refuses a session already paid but not yet completed.",
			"The music Work's player lost three shape problems: lyrics open as a drawer over the waveform at a fixed height rather than growing the stage, the transport centers elapsed time, the skip-and-play cluster, and remaining time in one group, and a waveform is drawn from each passage's loudness rather than its loudest instant, so a mastered track stops reading as a wall.",
			"Newly processed tracks carry the new measure, and a recompute pass reads the stored drawings back from each Work's source.",
			"The Badge Maker lives on a creator's own profile now, in the Badges tab above the supporter-facing ladder, and a rung added, renamed, or given art there updates the ladder on the same screen. A profile's fields edit in place, with a pencil on each; the batch form and preview toggle are gone, and Member since sits beneath the bio.",
			"Creator Settings is rebuilt around a Communications table, where Sales, Refunds, and Payouts each answer None or Email, and a Your ATProto Connection card lists every collection Anthers publishes, how many records the identity holds, and a link to each.",
			"The Upload page's page sets report themselves now: each added file gets a row with its name, size, percent, and cancel, files not yet started wait in a queue that survives Studio navigation, a failure holds the pick at that file with Try again and Skip, and Stop adding the rest keeps what landed.",
			"A pick attaches as one mutation and asks one render rather than one per page, and a video's tall rungs encode from a single decode, keeping the first quality's early release while the ladder finishes sooner.",
			"The Studio's Works table holds one rule at every width now: Description is the only flexible column and clips as it narrows, the table scrolls once it reaches its floor, every cell centers, Access moved under the Work title, and a Reviews column reads the net and its two counts.",
			"The signup page carries one optional ask now: the Creator Badges step, its fee breakdown, and its creator finder came off, and the Anthers Badge is the page's only optional step, unnumbered. A pending signup made before the change still applies its creator picks.",
			"The signed-in footer sits only on the account pages that use it, Badges, Purchases, and Settings, and the homepage's first section after the hero is revealed on load rather than waiting for a scroll. An audio hover preview follows the sound setting and carries the speaker button video previews have, and a dashed rating cell reads N/A where its rung is unreachable.",
		],
	},
	{
		version: "2026.10.28",
		date: "2026-10-18",
		lede: "An Image Work carries a set of pictures now, a creator's financials are explained and calculated on one page, and the signup Badge matrix shows each rung's split and discounts as they actually run.",
		entries: [
			"An Image Work holds a set of images now: one Work, one upload rail, several pictures the creator orders, and the Studio's image section edits the set with add, remove, and reorder. The first picture leads as the cover a listing and a shared link show, and the Work page displays it with a lightbox that steps through; a one-picture Work reads as it always did.",
			"A creator's financials are explained and calculated on one page now, at /resources/creator-financials: how support, sales, and storage pay, worked through with a calculator over what somebody would host, how many supporters, and what they would sell, with figures read from the same fee constants the site's other published figures use.",
			"The free account's pool on that page renders the Time Pool Fund's published monthly figures, stating the figure varies where the month's numbers are not in hand, and the two staging calculators the page replaced answer their old addresses with redirects.",
			"The signup Badge matrix shows the merch discount each rung actually carries now, read from the same constant the store applies, where every cell used to answer Yes under a Not Built Yet mark; and the free column's monthly figure says its amount varies, explained behind the information icon, where a flat note used to sit under the value.",
			"The Badge matrix gained an Anthers Support row, naming for each rung the portion of the monthly amount kept for Anthers' own costs and the charitable programs, derived beside the other money lines rather than typed, so the whole split reads in the matrix before a rung is picked. The free rung has nothing to split, and the walk-down table that sat below it left the page.",
		],
	},
	{
		version: "2026.10.27",
		date: "2026-10-17",
		lede: "A free account's Time Pool comes from the Time Pool Fund now, a video releases the moment its first quality is ready, and the states a Work page used to render as nothing hold their places.",
		entries: [
			"A free account's Time Pool is funded by the Time Pool Fund now: Free Access's stated share of the remainder, published monthly, divided across the cycle's active free accounts. The free figures the site quotes read the Fund's published ledger rather than a fixed per-account figure, and a place still waiting on the fetch says the figure varies with the month rather than showing a stand-in.",
			"A video releases as soon as its first quality is ready now, where publishing waited on the whole ladder, and the processing behind it got faster and truthful: audio jobs run two at a time where a single lane idled most of the machine, the waveform pass draws in seconds with progress that follows the real work, and a queued job's stated wait is measured rather than carried over from a slower era.",
			"A creator's home feed carries their own published posts and released Works now, entering under the same filters, sort, and access rules as the entries of the people they follow, so a creator who follows nobody reads their own work rather than an empty page; and the creator page's timeline renders the feed's tiles, where its own card family fell back to a bare question mark for a name.",
			"A shared link previews now: the site's card and description ride the served head, and each page's browser tab carries its own title, where one static title answered for every route. The card names the site, not a Work; the pages ride a static origin, and the head they share cannot describe the Work behind one link.",
			"The Work page stopped rendering absence in its unfinished states: a free Work with no thumbnail, read signed-out, keeps its media card standing, where a collapsed frame clipped what sat inside it; and a previewed unreleased Work carries the editor's silhouette into the Record (the fileless video, the track before its file, the build before its files), where a slot answered nothing.",
			"A music or spoken-audio Work's page gives its media a stage that fills the frame now: the waveform, normalized to the track's loudest passage, stands at full height as the page's reading surface, the transport sits pinned at the foot, and a song's lyrics open as a scrolling column beside it.",
			"The save shim inside a hosted browser build got the fixes its first live proof found: a first visit boots where a held storage connection blocked the build after it downloaded, presence beats attach again so played time accrues while a game runs, and a save restored from the cloud reaches the engine in the shapes it reads.",
			"The Studio's Works table carries Media Status now, a video row showing the per-variant chips its Manage tab does (the original, the audio rendition, the ladder), and the Release Date column edits in place: publish now, set a schedule, or clear one, without opening the Work.",
			"The Work editor's Kind select leads the Manage tab now, the kind deciding what the tab's machinery is, and the View As row keeps its place through a preview with room for its labels, where a squeezed control wrapped them.",
			"A fileless draft receives its first file in the frame the page holds for it now, the drop zone moved from the Manage tab's form into the Work placeholder itself, and the Work page's tab groups hold their tallest panel's height, so switching a tab no longer moves the page.",
			"The Work page's store panel composes beside the product image now: the mockup owns one column at the composition's full height, the pickers and the price own the other, and the buy door spans both at the foot; the price is on screen the moment the panel is, so picking a variant never moves the layout.",
			"The creator cards in signup carry the creator's actual Badge ladder now: the rungs render as chips with their marks and monthly amounts, hovering a rung states its perks, and giving follows the creator, where a Back button used to stand; tapping a lit chip steps off while the follow stays.",
			"The meadow behind the signed-in pages receded: it renders softer and blurred now, so the pages scroll over it as distant texture, and the vines that crossed the content column are gone.",
		],
	},
	{
		version: "2026.10.26",
		date: "2026-10-17",
		lede: "Projects are edited at their own addresses now, posts are edited in place, and the processing queue states where an upload stands and what its wait is.",
		entries: [
			"A Project is edited at its own address now, the model the Work page runs: the public URL is the editor, with pencilled title, tagline, description and publish field, the cover uploading in place, and the member shelves living on the page where the Studio's edit form used to hold them.",
			"Filling a Project's shelf became a multi-select table, whose rows click to toggle and whose one confirm adds everything ticked, and sorting offers Manual, Release Date, Original Release Date, and Alphabetical; Manual is the only real order, and the grip is the only way to change it.",
			"A draft Project's page stopped rendering for every visitor who held its URL, where the server had never checked publication: it answers 404 now, as a private Work's does.",
			"A post's page carries its body in the card now: the byline, title and record strip sit above it, the votes and stickers below, so the border wraps the writing rather than the whole page.",
			"A creator who opens one of their own posts from the Studio lands on the post itself, editable in place with the pencils and the publishing machinery beside it, where a separate editing form used to answer.",
			"Retitling re-derives the address, for posts and Works both, with the trailing publicId unchanged, so every link naming the old slug keeps resolving.",
			"A Work named in a post's body renders its card beneath the text; linked Works are done away with as a first-class field, the links are read back from the body, and each Work arrives through its own gates, so an embed is a citation and a gate stays a gate.",
			"Processing media became one queue that describes itself honestly: video and audio line up in a single lane rather than two queues racing for the same worker, and the position a waiting job reports is rewritten at every change in the lane.",
			"A waiting job now says what stands ahead of it beside what it is expected to take, and audio reports its progress as it runs, the way a video's ladder always did, where a burst of uploads had left an estimate holding a figure reality never met.",
			"The Work page's layout was reworked: the Details tab leads with the release dates above the description, a second release date rides under the byline, a hairline divider sits above the two-column record, every pencil sits beside the field it edits, and a description past a readable length folds behind a Read more.",
			"The editing banner is gone from the Work page; the Manage tab leads, and its View As row previews the page as an unlocked user, a locked user, or signed out, where a slider used to imagine an amount.",
			"Every kind of media on a Work's page sits in one card derived from the video layout, and the card holds a definite width, so the page stops jumping as a video loads.",
			"The meadow came to the signed-in site: the pollen, the woven side vines with their bees, and the grassy floor now paint behind the signed-in pages, the Studio included, always beneath a Work's or a Post's own surface and never riding across one.",
			"The Settings pages gained width, their toggle descriptions wrap instead of clipping, and a tab visited this session holds its place while another is read.",
			"A thumbnail frame saved from a video answers in a fraction of the sixteen seconds a save took: the image's safety scan reads the bytes already in hand rather than pulling the stored file back out, and a moment picked mid-video extracts directly instead of probing the whole original.",
			"The signed-in footer sits at the bottom of the viewport now, even where a page runs short.",
			"The Studio player asks for the work's rewritten HLS address now and never the raw storage one, where a saved Work's player could request a file it had no way to open.",
		],
	},
	{
		version: "2026.10.25",
		date: "2026-10-16",
		lede: "Badges are purchasable from every creator's page now, the Badges page took the subscription page's place, and audio keeps playing across the site in a footer bar.",
		entries: [
			"A creator's Badge ladder became a purchase surface on every page that carries one, Anthers' own page included: a visitor picks a rung, adds it to the basket or buys it right there, signed in or out, and the give card priced by the retired budget model is gone. An upgrade is charged as the difference it is, and Badge money settles through the monthly distribution.",
			"The Badges page took the subscription page's place at /badges: the ladder Anthers issues leads the page with a breakdown of where its money goes beside it, the Badges the account holds from other creators sit under it, and the month's accounting reads as a table now, where a pie chart used to carry it. The old /subscription address redirects.",
			"Listening follows the account around the site now: pressing play on music or spoken audio hands it to the footer bar, which stays put through navigation, and the Work page's player mirrors it. That behavior is an account-level setting, on by default, and a signed-out visit, an embed, or a Studio preview still plays inline.",
			"The music on a Work's page got the transport it was missing: skip back and forward around a large play button, keyboard shortcuts, a waveform drawn to match its space rather than stretched fat, and a lyrics card that folds away when it is not wanted.",
			"A track can be heard while it still processes now, served as its original behind the same access check and metering every stream runs; and where no player can fill the Work's place yet, the place itself holds a shaped placeholder, so the page stops jumping when the file lands and processing starts.",
			"The desktop app signs people in without leaving the window now: the address is typed, the emailed code is spent in the app, and the session it opens is revocable per device from Settings. The handoff to a browser remains for signing in with Bluesky.",
			"A credit's kind states the copyright boundary it draws now: a creator's editor offers Created and Generated, the retired Licensed type is rewritten where it named somebody and dropped where it named nobody, and the badges a reader sees on a Work keep AI as the word for machine-made contribution.",
			"The sticker picker opens over the page now rather than pushing it down: a pill beside the votes opens it, the rows run smallest to largest, and each row names what the Sticker directs and how many of that denomination the account's allowance still affords, so the giver no longer divides a remaining balance in their head.",
			"Every field on a Work's page shows its full structure at every value now, an unfilled one wearing a fitting placeholder, so the layout is the same from Work to Work and nothing hides a place worth editing; and the Rating tab is the rating table itself in both views, answered in one act, with its two grid answers named None and General.",
			"The topbar's light and dark switch became a theme picker: an icon dropdown in the corner utilities, grouped into Light and Dark, with the catalog's one theme named and the active choice marked. The logged-out navigation's two doors changed order, Log In leading and Sign Up Free closing the corner.",
			"The Resources landing was rebuilt around its audiences: one band each for users and for creators, one for what Anthers does with its own money, opening on the media-month calculator and the money-flow drawing, and the page returned to the navigation it had left while the rebuild was under way.",
			"The post page took the bordered-card treatment: a post reads inside a card now, the creator's name sits above the title, the vote buttons carry their counts, and the record's Taproot link rides the header.",
			"The Studio's tables caught up with one another in the same pass: the Posts page joined the Works and Projects pages as a table, a row's description sits in its own column beside the title, and a Project row's cover image opens the Project, as a Works row's thumbnail already did.",
			"The Work editor's thumbnail section was rebuilt without losing the creator's place when the page's height changes, and the sidebar's mode toggle moved onto the sidebar's own edge, its two modes reading User and Creator.",
			"The public roadmap's cards were corrected against what shipped: traffic analytics reads as launched, and the copy on three cards claims only what a skeptic can check.",
		],
	},
	{
		version: "2026.10.24",
		date: "2026-10-15",
		lede: "Traffic became a first-party measurement described exactly, a calculator joined the resources, and a Work's page is the one editing surface.",
		entries: [
			"Anthers measures its traffic with its own first-party analytics now: page views and feed-card impressions are counted in Anthers' own tables, apart from the attention pipeline that pays the Time Pool, so a page view and a play are different figures and stay that way.",
			"The measurement carries no cookies, no account, no identity, and no IP address: a session's visits ride a random label generated per tab, which is never sent as a cookie and is gone when the tab closes, and raw rows are deleted after thirty days into page-level totals. The Privacy Policy describes exactly this now, and its Cookies section names the label the measurement rides.",
			"Creators see where their traffic comes from in the Studio now: visits per day across their own pages, split into direct, search, social, and other referrers, read from the same tables with no new collection of any kind.",
			"The media month calculator is live at /resources/media-month: a reader assembles a month from a video subscription, a music one, storefront purchases, direct support, and the free ad-supported line, and reads two itemized receipts side by side, what their money does today beside what it would do on Anthers, with a marker wherever a platform's figure is not published.",
			"How money moves through Anthers is drawn as a resource now, in percentages: the three ways a person's money arrives and every way it leaves, card processing at cost, half of an Anthers subscription to the Time Pool, the remainder to the charitable programs, and creator money passing through in full. It replaces the projections resource, which left the public site while the plan is still settling.",
			"A Work's page became the one surface for every kind now: a creator edits the Work at its own address, with the mode banner, the centered byline strip and the two-column record, a video carries Info and Showings tabs, and a reader's page of any kind is the same tabbed record, with the per-kind linear pages and the goods two-up retired.",
			"A video, spoken audio, or music carries creator-authored chapters now: every timestamp the creator typed into the description is a cue, the timestamps render as links that seek the player, spoken audio and music list the chapters in the transport, and video adds a segmented seek bar. A timestamp in a review body renders the same way, and a ?t address opens the Work at that moment.",
			"A basket holds items from several creators now: the rule that wiped it when a second creator's Work went in is gone, the charge settles the creators together, and each creator's share moves out at completion.",
			"A merch order quotes itself in the store panel now: with a color and size picked while signed in, the panel names the discounted goods, the shipping, and, from the buyer's saved billing zip, the tax-inclusive total. A buyer without a saved address sees goods and shipping with tax calculated at checkout, and a signed-out buyer sees no quote, since the quote prices account facts.",
			"The Bookshelf carries its continue-reading rail now: where a reader stopped is kept as they read, so the rail surfaces each unfinished book, comic or text at the place to pick up, and the spines' progress ribbons read the same record.",
			"Hover previews gained their stops now: a Media & Play settings row turns the inline playback off entirely, and sound is the viewer's gesture rather than the hover's, a preview always beginning muted, with a speaker button on the preview and a remembered setting for audio on hover previews, default off.",
			"The status page was rebuilt with a memory: an overall state banner, uptime bars sampled every five minutes, and an incident log, where it used to answer only about this moment.",
			"The Activity & Data tab's history answers in a picture now: one bar per day of the billing period, stacked by creator, above the row record the Privacy Policy points at.",
			"The Studio Dashboard carries a Schedule panel now: every scheduled release and post on one soonest-first list, each row naming its kind, its date, and the editor where the schedule was set.",
			"The last subscription surfaces carrying the retired budget-allocation model let it go, so a subscription reads as what it is: one amount, pointed one of two ways.",
			"Refund records keep up with the live Stripe API now: a charge.refunded event that arrives without its refunds list reads the facts from the charge itself, where the first live refund had silently dropped both the refund id and the transfer reversal.",
			"Names across the site were swept into title case, so the older pages agree with the rule the newest surfaces were written to.",
			"A card's creator name is its own link now, on the feed tiles and the Work and Post cards, and it leads to the creator's profile rather than the card's target.",
			"The signed-in sidebar's selected filter rows carry the navigation's treatment now, where a soft yellow sat nearly invisible on the light theme.",
			"Turning a page while the book is still opening no longer freezes the ebook reader.",
			"Every promoted release carries the signed web bundle the desktop pins, retiring the separate web-v release channel.",
		],
	},
	{
		version: "2026.10.23",
		date: "2026-10-12",
		lede: "A book is readable on Anthers now, a video carries captions for the first time, and the Studio's Works and Projects pages became tables.",
		entries: [
			"An ebook Work takes an EPUB now: the book's text and images are ingested into private sections that serve only through the same access ladder every stream runs, and a reflow reader built on the vendored foliate-js engine renders them, so the type flows to the window it is read in.",
			"A video carries captions now, and a creator supplies them: the Studio's Work editor gained a captions panel, a track's WebVTT is validated as it attaches, and the player offers the cues beside its other controls, served behind the same access check the video itself answers.",
			"Hovering a feed tile plays the Work inside its frame now, muted and in place, and the preview counts as an ordinary open play: its seconds earn a creator and spend Public Access exactly as an opened play does. It rides a deliberate hover only, one tile at a time, and plays only where the Work is open anyway: a gated tile keeps its poster, a blurred one its blur.",
			"Where a video carries an adaptive ladder, the quality menu now offers the original as an opt-in alternative, and a rung click returns the player to the ladder's variants. In the Studio, a video's original plays while its ladder encodes, so the page answers with the player rather than a processing block, and the thumbnail's frame is picked from that same player.",
			"The Studio's Works and Projects pages are tables now, in the shape YouTube Studio's Content tab reads: tall rows carrying a thumbnail, visibility, status, upload date, and counts as columns, sortable by header click and filterable from the signed-in sidebar, with a Projects row carrying the works its project holds, each opening on the Work's Edit page.",
			"The Library holds two lenses beside the music player now: the Bookshelf draws text, ebook and comic Works as spines aligned to a shelf line, with a reading-progress ribbon on the paged ones, and the Channel Guide reads a video collection like a TV guide turned on its side, the channels in columns left to right by name, each column one creator's videos stacked newest first.",
			"The signed-in sidebar carries a structure shared across its pages now: Lenses rows on every tab, live where a lens is built for the page and grayed as Coming Soon where it is not, and shared Type, Tags and Access filters beneath a persistent divider. The Feed's Bookmarks strip retired with the change; saving remains the one keep action.",
			"A Work's media is managed in place now: a creator can replace a source, sweeping the files the replaced version left behind, take a never-released Work back to an empty draft, and cancel a pending or processing media job rather than wait it out.",
			"The upload page states what Anthers accepts beside each picker now, one set naming the video codec pairs, audio, the paged kinds' sources, and images, and the refusal for a source outside it says the same words. A source whose codecs can travel is remuxed into its native container without re-encoding, so an MKV or OBS capture publishes as it stands.",
			"A retried upload finds its own session again, by the file's digest carried end to end: a relaunch names the digest at open and receives that session's plan, sends only the parts still missing, and the file is confirmed by the same digest at completion.",
			"Video encodes run several times faster: the worker holds two dedicated vCPUs where a real transcode crawled 55 minutes on a shared one, and the ladder's variants encode with x264 veryfast, measured two and a half to three times faster on the tall rungs and visually indistinguishable at the job's bitrates.",
			"The queue that processes media stopped three failures seen in production: a job no longer encodes the same file twice after its expiry, an exited encoder's drained output no longer writes progress past a job's own completion, and a deploy's graceful stop no longer spends one of a job's resume allowances.",
			"Holding a creator's Badge follows that creator now, at both places a holding is written, and canceling it never unfollows; a follow leaves only by the account's own act.",
			"An image Work carries a description the creator authors beside the picture, and the post editor's insert flow asks for one the moment an image is in hand; the description is announced on the Work page and in rendered post bodies.",
			"A Created credit's missing-contributor warning appears when a save is attempted now, rather than the moment the box is ticked, and any edit to the credit rows silences it again until the next attempt.",
		],
	},
	{
		version: "2026.10.22",
		date: "2026-10-11",
		lede: "A video plays the moment it is published now, and an upload is a session that resumes rather than a file that starts over.",
		entries: [
			"A released video plays the moment it is published: its stored original serves, behind the same access check and Public Access metering every stream runs, so publishing no longer waits on an encode. Where a ladder of adaptive variants exists, that stays the offered experience, the original underneath for a later quality menu; a creator's own preview of a finished video plays the same way.",
			"An upload is a resumable session now: the bytes go straight to the storage network in parts the creator's browser can retry individually, so a dropped connection no longer starts a large file over, and a session left unfinished for three days aborts itself, because held parts bill.",
			"A Work can be drafted with nothing but a type and a name, so a failed upload costs nothing typed beside it, and an empty draft can change its kind, with the rating read against the kind that then holds.",
			"A comic or a book is an ordered set of sources now: one PDF, several each contributing a contiguous run of pages in the set's order, or page images directly, where one JPG or PNG leaf is one page. Pages number across the whole set, files are added, removed, and reordered from the Work's own page, with each change re-rendering what it touched, and the pickers take page images beside PDFs.",
			"A comic or book's PDF may weigh what a video's may, at 2 GiB: the old ceiling was the render pass's disk budget rather than a rule of the storage network.",
			"The signed-in home page is just the feed now: one full-width shelf of wide tiles, with the Discover Projects section and the creator suggestions gone. And a feed that stops is a feed that ended: the timeline walks on behind a Load more button, where it used to end flat at the hundredth post, indistinguishable from running out.",
			"A buyer may keep one billing address: saved and cleared only in account settings, stored on their Stripe customer rather than on Anthers' servers, prefilled into checkout read-only and never offered to save there, with shipping still per order. The Privacy Policy carried the disclosure before the first address ever saved.",
			"The Studio's Catalog page split in two: Projects and Works are their own pages now (/studio/projects and /studio/works, the old addresses redirecting), each with its own New button. The Add a Work picker picks existing Works rather than minting a bare one, and the credits section warns about a missing contributor at its rows only, where a page-wide alert used to duplicate it.",
			'The top-level marketing pages had a voice-and-fact pass: the supporter card no longer promises gated interactions or purchase discounts, "every dollar funds" and "in full" carry the half rate and the at-cost card cost, the federal exemption states itself as an intention only, and the FAQ names the built fourteen-day hold rather than "Stripe\'s schedule".',
			"The pay-comparison rows were rebuilt from each platform's published rates: Ghost's current plans, itch.io's share as a creator-set default, YouTube's split, Patreon's flat rate, Substack's fee priced in, and Steam's crossing point computed from the card rate. The monetization calculator's example receipt now nets directed support against the card fee it rides.",
			"The supporters page no longer says the platform is closed, and the browser-game rows describe what exists honestly: a game embedded from a creator's own host, Anthers' own serving not yet built.",
			"The worker's CPU alert reads as a saturation notice now: a pegged graph is the component's healthy shape while media is queued.",
			"The jobs that process media stopped holding whole files on the worker's disk: the transcode uploads each variant the moment it finishes and reads its source in place, as do the ladder encode, the safety scan, and the audio and ebook jobs, and a daily sweep clears the run prefixes nothing is waiting on. A burst of video uploads that filled the worker's disk set this off.",
			"The sign-in card holds its size while the hint under the field changes, so typing a handle no longer stretches the card taller and shorter, and the Continue button keeps a line of air.",
		],
	},
	{
		version: "2026.10.21",
		date: "2026-10-10",
		lede: "The records behind the pages open from the pages now, and the money plan's hierarchy reads the way its ledger runs.",
		entries: [
			"Every kind of record that has a page now carries a link to itself beside it: a Work, a Post, a Project, a comment, or a Review names its record's address on Taproot, the public record explorer, and every user of the page sees the link, signed in or not. Votes and follows carry none, because neither has a page of its own.",
			"The support model's hierarchy reads as it is everywhere now: Programs is the parent line, and Free Access and Free Storage sit inside it as the programs they are. The Admin Console's plan table and its flow diagram draw the corrected shape, and the copy on the FAQ, legal, signup, and economics pages says the same thing.",
			"The Resources landing came off the logged-out header, the mobile drawer, and the footer navs ahead of the page's redesign; the page still answers at /resources, and the links to it inside other pages stay.",
			"The Admin Console's Infrastructure tab carries an Email Library now: every standard and automatic email Anthers sends, cataloged in one place and previewed with placeholder data rendered from the templates the product itself sends with, and any template can be test-sent to a real inbox one at a time.",
			"The Feed, Library, and Discover items in the signed-in navigation read as rows again, and the grips that drag them into a new order actually drag.",
		],
	},
	{
		version: "2026.10.20",
		date: "2026-10-10",
		lede: "The signed-in feed's filters work now, and the Financial Plan edits like a worksheet.",
		entries: [
			"The signed-in feed's sidebar shows only what the feed honors now: a Bookmarks shelf listing the posts the account saved, access and Work Type filters, and a tag search that gathers several tags at once. Each filter actually filters the feed, carried in the page's address and applied before the page fills, so a filtered page is a page of matches.",
			"The Following and New Releases shelves, which sorted nothing, are gone; the feed opens with its own heading, and the how-it-works link sits beside it rather than in the sidebar. The Feed, Library, and Discover items carry drag handles, their order persists to the account, and the top of the order is where a signed-in visit to the home page lands.",
			"A text Post's tile reads like a post now: the band carries its opening, and the card beneath shows its title with a shorter excerpt, where an eyebrow and an empty card used to sit.",
			"A physical Work's tile shows its store rather than a lock, the creator's thumbnail or the store's first mockup with a from-price badge where the lock chip stood, and a goods Work's card on a profile or a project shelf shows the same face. Gated goods still lock, like any gated Work.",
			"The Admin Console's Financial Plan table is always editable now: inputs sit in the cells, each row saves as its fields change, a Save chip reports the unsaved rows, and an invalid field blocks only its own row. A background refresh no longer tears the page down mid-edit, and phases can be added, removed, and given their own share overrides.",
			"The plan's flow diagram reads in three columns now, revenue, then the obligations, then the spending each stands over, with the granular figures drawn from the shared model and an over-spent phase printing its overruns in red. A radio at each table row picks the phase the diagram draws.",
			"A drifted record's diff on the ATProto Records page reads field by field: differing fields first, Anthers' copy beside the fetched record's, where two raw JSON blocks used to sit. The comparison is the drift badge's own, so the two cannot disagree; other findings keep the raw view. The console's sidebar holds still while its section scrolls, and Job Queues renders last on the Infrastructure page.",
		],
	},
	{
		version: "2026.10.19",
		date: "2026-10-10",
		lede: "The store pages read like a shop now, and sharing never stops to argue.",
		entries: [
			"A Work's record — credits, stickers, reviews, announcements — now sits in a column beside a goods Work's store panel instead of under it.",
			"The store panel's pickers are labeled Variants: every size a Work carries shows from the start (one the picked color doesn't offer greys out), the mockup keeps to its space, and the always-visible list/shipping/tax box waits for the saved-address decision rather than restating what the size buttons already say.",
			"Share opens a modal that always offers a copy — a gated Work's link is worth sending, to point someone at something they might buy — and upgrades to the watching link where the Work allows one.",
		],
	},
	{
		version: "2026.10.18",
		date: "2026-10-09",
		lede: "The shirts wear their own pictures now.",
		entries: [
			"A physical Work's page shows the product: the store binding carries each color's mockup from Printful — the shirt in the color you're pointing at, swapped when you pick — pulled from the store so a dashboard change is all a picture update takes.",
		],
	},
	{
		version: "2026.10.17",
		date: "2026-10-09",
		lede: "A Work that can't be streamed no longer borrows the rules built for the ones that can.",
		entries: [
			"A physical Work's page now reads without an account, exactly as an account sees it: the store panel stands where a player would, with the color and size pickers and the store's own prices, and creating an account is asked only at the buy door. The access table still gates the page, and a purchase once made no longer closes the store — a shirt is a shipment, not an unlock, so a buyer may buy again.",
			'The free-account card\'s copy lost "to watch" — the sentence stands over music, comics and essays as well, none of which are watched.',
		],
	},
	{
		version: "2026.10.16",
		date: "2026-10-09",
		lede: "The shirts went on sale on their Work pages, and storage started measuring what accounts actually hold.",
		entries: [
			"Anthers' own shirts went on sale on their Work pages: the page carries color and size pickers and prices the shirt at the store's own list, with a held Badge's discount applying to the shirt's price at checkout. Shipping is Printful's charge, priced at checkout and never discounted, and every order rides the store's carbon-offsetting delivery option.",
			"Printful prints each shirt on demand and ships it straight to the buyer; the purchase keeps the order's record, and the tracking arrives there as Printful reports it. A returned shirt cancels its print order wherever Printful's own states still allow the cancellation.",
			"A creator's storage reads on the dashboard now: how much the catalog and the kept files hold against the held rung's allowance, for every account. Keeping files past a storage obligation's end is an election the creator states, and the claim-aware sweep watches the deadline.",
			"A renewal's invoice carries the month's metered overflow at the object store's own rate, with no mark-up, so the ruled shape the pricing copy describes is the one the money follows.",
			"Notifications arrived as a feed and a bell: engagement with a creator's own works, and publishing from creators a reader follows, with the kinds of notices a creator receives chosen per group rather than fixed. Money keeps its own receipts instead.",
			"A payout that left Anthers now emails the creator it reached, naming the amounts, at the moment the transfer landed.",
			"The credits a creator gives a contributor have their own Studio panel, and its identity field suggests handles as the creator types.",
			"The signup page wears the dark palette and the banded rhythm the site's other top-level pages read as.",
			"The ATProto Records page fetches its records from the right paths again, and the infrastructure navigation no longer highlights two sections at once.",
			"The status page's heartbeat reports again, and the queue check inside it can no longer run long past its own timeout.",
		],
	},
	{
		version: "2026.10.15",
		date: "2026-10-07",
		lede: "The Badge Maker: a creator's own Badge art, drawn from a catalog of nearly ten million icons and credited to the artists who drew them.",
		entries: [
			"The Badge Maker is live, and it is the one place a creator makes a Badge: the name, the monthly amount, the perks, and the art. The old ladder editor's small set of preset emblems is gone; a rung's emblem is picked from the Noun Project catalog through a live search, or uploaded as a creator's own file.",
			"The catalog search suggests visually similar icons for the rest of a ladder, so a set of rungs reads as if drawn by one hand. Every catalog emblem shows its artist's name in the picker, and a supporter who flips a Badge over on the creator's profile reads the same credit.",
			"A composed Badge image is built on Anthers' servers at save time. The icon file itself is never downloadable from here, and a rung a creator has not touched yet wears one of Anthers' own Badge designs until they give it an emblem of its own.",
			"Perks are a new part of a Badge. A creator tags what a rung carries beyond access, from four plain categories (a physical good, a service, community access, or recognition), each with a plain-language explanation, and access to gated works is added automatically.",
			"Storage moved onto a ruled ladder: the free allowance is 25 GiB across a creator's catalog and their kept files alike, each Badge rung bundles more, and past it a creator pays the object store's rate with no mark-up. The half-again mark-up retired, and the FAQ, legal copy, For Creators and signup pages state the ruled shape.",
			"The Admin Console gained the financial plan as an editable projection from launch to inflection 1, with the budget shares beside it and the flow diagram a phase's numbers draw.",
		],
	},
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
