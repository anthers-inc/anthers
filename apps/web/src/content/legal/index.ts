// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The published text of the legal documents.
 *
 * **Canonical text lives in the vault** — `51.05 Privacy Policy`, `51.06 Terms of
 * Service`, `51.07 Creator Terms`. This is the rendered copy with the internal
 * apparatus removed: no `⚠️ NOT YET BUILT` markers, no DO-NOT-PUBLISH banner, and none
 * of the "Notes for us, not for publication" section, which is reasoning about the
 * documents rather than part of them.
 *
 * 🚨 **`effectiveDate: null` is what makes publishing these honest**, and it is not a
 * placeholder. A document with no effective date renders a banner saying it is not in
 * force; adding a date is the act that turns a draft into a representation people can
 * rely on. Parker's call, 2026-08-10: publish pending, date them once the outstanding
 * legal review clears. **Do not fill these in because the copy looks finished** — that
 * is the exact hazard the vault banner named.
 *
 * When the text changes materially, `services/notifications.ts` is how people are told
 * before it takes effect. That is a promise in the policy, not a nicety.
 */

export interface LegalDocument {
	title: string;
	/** One line under the heading. */
	summary: string;
	/** `null` until it is genuinely in force. See the module note. */
	effectiveDate: string | null;
	/** Paragraph-level blocks; `##`/`###` head a section, `- ` opens a bullet group. */
	blocks: string[];
}

const PRIVACY: LegalDocument = {
	title: "Privacy Policy",
	summary: "What we collect, why, and what you can do about it.",
	effectiveDate: null,
	blocks: [
		"The information you and your work generate on Anthers is **yours**. We collect what we need to run the platform, pay creators, and keep people safe — and nothing beyond that.",
		"**We do not sell your personal information, and we do not share it for advertising. There is no advertising on Anthers.** We are a nonprofit; nobody here profits from your attention, and the platform has no business model that would reward collecting more about you than it needs.",
		"This policy is written to the strictest standard that applies anywhere we operate, and extended to everyone — we don't give you fewer rights because of where you live.",

		"## Who we are",
		"Anthers is operated by **Anthers, Inc.**, a Colorado nonprofit corporation. You can reach us at privacy@anthers.org, or at PO Box 21233, Denver, CO 80221.",

		"## What we collect",
		"**Information you give us.** Your username, email address, and password (stored only as a cryptographic hash — we never hold your actual password). Optionally: a display name, bio, avatar, header image, website, and location. All optional fields are free text you choose, and anything you put in them is public.",
		"**Information created by using Anthers.** Your posts, Works, comments, reviews, follows, bookmarks, and projects.",
		"**What you view, and for how long.** When you play, watch, read, or listen to a Work, we record that it happened, which Work it was, and for how long. **We have to**: this is how creators get paid by watch-time, and there is no way to pay someone for the time you spend with their work without recording the time you spend with their work. See *How long we keep it* below.",
		"**Technical information.** Your IP address and browser user-agent, recorded with each sign-in session so you can review and revoke your own sessions and so we can investigate abuse.",
		"**Payment information.** If you give Seeds or buy something, **your card details go directly to Stripe and never touch our servers.** We keep a record of the transaction: what was bought, the amounts, the fees, sales tax, and Stripe's identifier for the payment.",
		"**Safety information.** If you report content or someone, or if something of yours is reported, we keep a record of the report, the decision, and who made it.",
		"**Linked accounts.** If you connect a Bluesky or other ATProto identity, we store the tokens needed to maintain that connection, and your handle and identifier.",

		"## What we don't collect",
		"No advertising identifiers. No analytics service. No third-party tracking pixels. No data brokers, in either direction.",
		"**Anthers loads no fonts, scripts, or embeds from anyone else's servers** — everything the site needs, it serves itself, so that reading, watching or browsing here tells nobody but us that you did. The **one** exception is the payment processor's own software on the pages where you are paying, described below. We would rather name a single exception than write a sentence that is nearly true.",
		"**We do not build a device fingerprint of you.** We considered it as a defence against fraudulent card disputes and decided against it. The one exception is not ours and we won't pretend otherwise — **Stripe inspects your device and browser on our payment pages** as part of checking that a card is being used by the person entitled to use it. That is confined to the pages where you are paying.",

		"## What creators can see",
		"Creators receive analytics about their own work: how many people viewed it, total time spent, and trends over time.",
		"**Creators never see who watched what.** Analytics are aggregated by Work and by date, and your identity is never part of them. A creator can see that a Work was watched for forty hours; they cannot see that it was watched by you. This is a design commitment rather than a current limitation, and there is a test that fails if anyone changes it.",

		"## Who we share it with",
		"We share personal information only with service providers who process it **on our instructions**, only for the purposes below, and never for their own:",
		"- **Cloudflare** — your IP address, browser user-agent and request headers, for every request, plus **everything you upload**: your files, images, video and audio are stored on Cloudflare R2. DNS, DDoS protection, and filtering automated traffic. Every request to Anthers passes through Cloudflare before it reaches us.\n- **DigitalOcean** — application hosting and the database.\n- **Stripe** — card details, payment and payout records, and (on our payment pages only) device and browser information for fraud prevention.\n- **Resend** — your email address and the contents of the email we send you.",
		"We may also disclose information **where we are legally compelled to** — a valid court order, subpoena, or equivalent legal process. Where we are permitted to tell you, we will.",
		"We publish **aggregate, anonymised** figures — totals, trends, charitable transparency reporting — which cannot be traced to any individual.",
		"**We have never sold personal information and will not.** Under California law, we do not “sell” or “share” personal information as those terms are defined.",

		"## Cookies",
		"**There is no cookie banner on Anthers, because there is nothing to ask you about.** We use no advertising, analytics, or tracking cookies — the kind consent banners exist for. Every cookie here is one the site cannot work without, and the law that requires those banners exempts exactly these.",
		"- **Our session cookie** keeps you signed in. Without it, every page would ask you to sign in again.\n- **`__cf_bm`** (Cloudflare) tells automated traffic from real visitors, so the site stays up under attack. 30 minutes.\n- **`__stripe_mid` and `__stripe_sid`** (Stripe) are fraud prevention on our payment pages, and are **set only if you reach a payment page** — browsing, reading, watching and playing set neither.",
		"We also store a few settings in your browser rather than on our servers — your light/dark preference, for instance. Those never leave your device.",

		"## How long we keep it",
		"**Your account and content:** as long as your account exists.",
		"**Viewing history:** raw records connecting *you* to a specific Work are kept for **180 days**, which covers the billing cycle they belong to and the card-dispute window that follows it. After that they are aggregated into per-Work and per-creator totals and **the per-person records are deleted.** Creators keep their earnings history; a complete history of what you personally watched stops existing.",
		"One record survives that, and it is a payment record rather than a viewing one. So that creators can be paid, we keep — for as long as financial records must be kept — a per-month total of how much time you spent with *each creator* you supported. It never says which of their works you spent it on.",
		"**Sessions:** deleted when they expire.",
		"**Payment records:** kept as long as tax, accounting, and nonprofit reporting law requires, which is longer than your account may exist and is not a period we can choose.",
		"**Safety records:** reports and moderation decisions are kept after the account they concern is gone — deliberately. If a decision could simply be erased, *“why was my comment removed?”* would have no honest answer, and appeals would be impossible. These records are minimal and are not used for anything else.",

		"## Your rights",
		"These rights are extended to everyone who uses Anthers, wherever you live.",
		"- **Know** what we hold about you and why — this document, and on request the specifics.\n- **Get a copy** of your information and your content, in an openly readable format. It's in your settings, and it's immediate.\n- **Correct** anything inaccurate — most of it directly in your settings.\n- **Delete** your account and content — see below.\n- **Object** to a particular use, and ask us to stop.\n- **Complain** to your data protection authority, if you are somewhere that has one.",
		"We will not charge you for exercising these, and we will not treat you differently for it.",
		"Two of them are buttons rather than requests: **downloading your data** and **deleting your account** both happen immediately in [your settings](/settings), without asking us. For anything else, there's a form in the same place, and we will respond **within 30 days**.",

		"## What happens when you delete your account",
		"Deleting is **scheduled, not instant**: you have **seven days** to change your mind, and signing back in is all it takes to cancel. Confirming signs you out of every device straight away. We show you exactly what will happen to your things — with the actual counts from your account — before you confirm, because a warning you can't check isn't consent.",
		"We do not keep anything *because* a deletion is pending. The week is a grace period, not an archive.",
		"**Deleted outright:** your profile, email address, password, sessions, linked identities, follows, bookmarks, blocks, and viewing history.",
		"**Your comments and posts become anonymous rather than disappearing.** They're marked as deleted by their author, and your name comes off them. Conversations other people took part in stay readable — a thread full of holes is worse for everyone still in it, and replies to a removed comment would otherwise make no sense. If a specific comment or post contains information you need actually removed, tell us and we will remove it.",
		"**Your reviews become anonymous.** The score stays in a creator's average; the connection to you is deleted. Removing it outright would move a creator's rating through no fault of theirs.",
		"**Your Works that nobody has bought are deleted.**",
		"**Your Works that people have bought are withdrawn rather than deleted** — they leave public circulation and the people who paid for them keep them. We email each of those buyers to tell them, so they can download a copy they keep.",
		"**Payment and safety records remain**, as described above — but **your name comes off the payment ones.** We're required to keep a record of what was sold and what sales tax was collected on it; we're not required to keep a record of *who bought it*, so the transaction survives with you detached from it. There is no route back from it to you.",

		"## Young people",
		"**You have to be 13 or older to have an Anthers account.** We do not knowingly collect information from anyone under 13, and if we learn that we have, we delete it. There is no under-13 account and no plan for one — if we ever build something for younger children, it will be a separate service built for them, not a filtered corner of this one.",
		"**We don't ask your age, and we don't verify it.** That is deliberate. Verifying age properly means collecting identity documents or dates of birth from everyone, and we are not willing to hold that about you in order to check a fact about a few. It means someone under 13 could sign up by not telling us — we would rather say that plainly than claim a protection we don't have.",
		"**Content made for young audiences is free, and funded by us**, never advertising and never engagement-optimised. There is no advertising anywhere on Anthers and no mechanism anywhere that profits from anyone's attention, at any age.",
		"Some things about this service are worth a parent knowing, and they're set out in plain language on our [page for parents and guardians](/parents) rather than buried here.",

		"## Security",
		"Passwords are hashed with argon2id. Sessions are opaque tokens you can review and revoke. Purchased and gated media is stored privately and every link to it is generated per request, after re-checking that you're allowed to have it. Card details never reach our servers.",
		"No system is perfectly secure, and we will tell you promptly if something happens that affects you.",

		"## Changes",
		"If we change this policy in a way that materially affects your rights, we will tell you before it takes effect — not by quietly updating a date at the bottom. We email you, and we keep a record that we did.",
	],
};

const TERMS: LegalDocument = {
	title: "Terms of Service",
	summary: "The agreement between you and Anthers, Inc.",
	effectiveDate: null,
	blocks: [
		"These are the terms for using Anthers as a person — reading, watching, playing, commenting, giving Seeds, and buying things. If you publish work here, the [Creator Terms](/creator-terms) apply on top of these.",
		"We've tried to write these so you can actually read them. Where something is a genuine legal requirement we've said so plainly rather than burying it.",

		"## Who can use Anthers",
		"**You have to be 13 or older.** We don't ask your age and we don't verify it — see the [Privacy Policy](/privacy) for why — so this is a rule you're agreeing to keep rather than one we check.",
		"You're responsible for what happens under your account, and for keeping your password to yourself.",

		"## What you can expect from us",
		"Anthers is a nonprofit. **We take no cut of what you give creators** — the only deduction on a Seed or a purchase is the card processing that the payment network charges, which goes to the processor and not to us.",
		"We'll keep the platform running as well as we reasonably can, and we'll tell you before we make a change that materially affects your rights.",
		"**We won't sell your data, show you advertising, or optimise anything here to consume more of your attention.**",

		"## What we expect from you",
		"Don't post things that are illegal, that harass or threaten people, that sexualise minors in any way, or that you don't have the right to post. Don't try to break, overload, or get around the access controls on other people's work.",
		"If you break these, we may hide the content, or in serious cases end your account. We keep a record of what we did and why, so that if you ask, you get an honest answer.",

		"## Blocking and reporting",
		"You can block anyone. A block is symmetric — neither of you will see the other around Anthers — and it takes effect immediately without anybody reviewing it. It's your boundary, not a complaint.",
		"You can also report content or a person, which is different: that asks a human to look. We don't tell you what happened to an individual report.",

		"## Money",
		"**Seeds** are $3 each, monthly, and you choose who they go to. Seeds you give a creator go to that creator; Seeds you give Anthers fund the pool that pays creators by watch-time, pay their share of card processing at cost, and what's left funds free access and our charitable programs.",
		"**Direct purchases** are one-off. You pay the price the creator set, plus sales tax where it applies, and nothing else.",
		"Prices shown include every mandatory fee. Sales tax is the only thing added at checkout.",

		"## Refunds",
		"If you buy something and it isn't what it said it was, or it doesn't work, tell us and we'll sort it out.",
		"**You can get a refund on up to three downloaded purchases in any twelve months automatically.** Past that a person looks at it — which is not a refusal, and if your reason is genuine we'll still sort it out. The limit exists for a specific reason we'd rather say than dress up: a refund on something already downloaded comes out of the pool that funds free access, because Anthers keeps no margin it could come from instead.",
		"Refunding something you never downloaded doesn't count against that at all.",

		"## What you own, and what you let us do",
		"**You keep ownership of everything you make.** You give us permission to store it, show it to the people you've allowed to see it, and move it around the internet to deliver it — that's what hosting is, and nothing more.",
		"**We do not train machine-learning models on your work or your data**, and we don't let anyone else do so through us.",

		"## If you bought something and it goes away",
		"If a creator removes a Work you paid for, **you keep it.** It leaves public circulation and stays available to you. If a creator closes their account entirely, we email you so you can download a copy you keep.",
		"There are narrow cases where a creator can have work taken down immediately — a lost licence, a legal order, a safety reason — and in those cases you're refunded.",

		"## Ending things",
		"You can delete your account at any time, from your settings. It takes effect after seven days, and signing back in during that week cancels it.",
		"We can end your account if you seriously or repeatedly break these terms. We'll tell you why.",

		"## Disputes",
		"If something goes wrong, email us first — most things are fixable that way and we would rather fix them.",
		"If we can't resolve it, these terms are governed by Colorado law. **You keep the right to bring a claim in small claims court, and to seek an injunction.** You are not giving up the right to join a class action; we haven't asked you to.",

		"## Changes to these terms",
		"We'll tell you before a material change takes effect, and we keep a record that we did.",
	],
};

const CREATOR_TERMS: LegalDocument = {
	title: "Creator Terms",
	summary: "Additional terms if you publish work on Anthers.",
	effectiveDate: null,
	blocks: [
		"These apply **in addition to** the [Terms of Service](/terms) if you publish work on Anthers. Everything there still applies to you as a person using the platform.",

		"## Becoming a creator",
		"You need a verified email address and a completed payment setup with Stripe before you can publish anything. That payment verification is also, in practice, why **everyone publishing on Anthers is an adult** — we don't check ages, but Stripe does check identity.",
		"At launch you need to be in a country Stripe Connect supports. That's a limitation we've inherited rather than chosen, and we intend to be out of it.",

		"## Your work",
		"**You own it.** Publishing here grants us permission to host it, deliver it to the people you've allowed, and show previews of it — nothing else. You can remove it at any time, subject to the buyer protections below.",
		"You're responsible for having the rights to everything you publish, including music, art, and code you didn't make yourself.",

		"## Getting paid",
		"**Anthers takes no cut.** On a direct purchase you receive the price you set, less the card processing the payment network charges — the only deduction there is. Delivery costs nothing, however large the work or however many times the buyer downloads it. On Seeds given to you directly, you receive the full $3 less its share of card processing.",
		"You are also paid from the pool funded by Seeds given to Anthers, in proportion to time people spend with your work. A minute is a minute regardless of whether it's a game, a video, audio, or writing.",
		"Payouts run through Stripe on their schedule. Tax is yours to handle; we report what we're required to report.",

		"## Storage",
		"Your first 50 GiB of storage is free. Above that you're charged what it costs us plus half again, and that surcharge funds free access for people who can't pay.",

		"## If you remove work someone bought",
		"**People who paid for something keep it.** If you delete a Work that has buyers, it's withdrawn rather than destroyed — it leaves public circulation and stays in their library. We email them so they can download a copy.",
		"If you need something gone *immediately* — a lost licence, a safety reason, a legal order — that's a takedown request, handled quickly and separately, and buyers are refunded.",
		"If you close your account, the same applies to everything you've sold.",

		"## Moderation of your work",
		"We may hide content that breaks the Terms of Service. Removal is always a recorded decision rather than a deletion, so you can ask what happened and get a real answer.",
		"Reviews of your work are moderated by Anthers rather than by you — a creator moderating reviews of their own work is the conflict reviews exist to avoid.",

		"## Ending things",
		"You can stop publishing at any time. Your obligations to people who already paid you survive that, as described above.",
	],
};

export const LEGAL_DOCUMENTS: Record<string, LegalDocument> = {
	privacy: PRIVACY,
	terms: TERMS,
	"creator-terms": CREATOR_TERMS,
};
