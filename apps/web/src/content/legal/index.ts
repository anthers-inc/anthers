// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The legal documents. **This file is the canonical text of all three.**
 *
 * It was an abridgement of a vault copy until 2026-09-02, and that arrangement had already
 * failed: the two drifted, and the sharpest divergence was that the vault carried an
 * arbitration clause with four carve-outs while the served copy omitted arbitration
 * entirely. Two versions of a document that binds people is one version too many, so
 * Parker's call was to publish the *full* policies here and retire the vault copies. There
 * is no second copy to reconcile against any more, and there must not be one again — a wiki
 * page restating an instrument is a second representation of it, however friendly.
 *
 * 🚨 **`effectiveDate: null` is what makes publishing these honest**, and it is not a
 * placeholder. A document with no effective date renders a banner saying it is not in force;
 * adding a date is the act that turns a draft into a representation people can rely on.
 * **Do not fill these in because the copy looks finished** — that is the exact hazard.
 * Parker has not reviewed this text yet, and that review is the gate; it is tracked in
 * *Review the published legal instruments before the site goes public*.
 *
 * ⚠️ **Parts of this describe behavior that is not built.** That was true of the vault
 * copies too, where it was carried as `NOT YET BUILT` markers — and the serving layer
 * stripped marked copy, which is how the child-safety scanner ran for three days while the
 * published policy named four recipients and not the fifth. **Nothing is hidden here.** The
 * pending banner is what carries the caveat, and the inventory of what is still unbuilt is
 * in the review task rather than in the text, because a term a reader has to decode is
 * worse than a term that is simply not yet in force.
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
		"**Information you give us.** Your email address and username, and a password if you set one — passwords are optional here, and are stored only as a cryptographic hash, so we never hold your actual password. Optionally: a display name, bio, avatar, header image, website, and location. All optional fields are free text you choose, and anything you put in them is public.",
		"**A sign-in code, briefly, before there is an account.** When you start an account or sign in by email, we email you a six-character code and hold it — hashed, never in readable form — against that address for **ten minutes**, with a count of how many times it has been tried. Nothing else: no IP address, no name, and if you never finish, no account is created. See *How long we keep it*.",
		"**Information created by using Anthers.** Your posts, Works, comments, reviews, follows, bookmarks, and projects.",
		"**What you view, and for how long.** When you play, watch, read, or listen to a Work, we record that it happened, which Work it was, and for how long. **We have to**: this is how creators get paid by time, and there is no way to pay someone for the time you spend with their work without recording the time you spend with their work. See *How long we keep it* below.",
		"**Technical information.** Your IP address and browser user-agent, recorded **with each sign-in session** so you can see your own active sessions — where and on what — and end any you don't recognize, and so we can investigate abuse.",
		"**This is the only place we hold an IP address, and it isn't kept.** The record lives with the session and goes when the session does; there is no separate log, nothing is kept against your account after it expires, and **we do not record your IP when you pay**. If we ever need one for another purpose, it gets a line here and a stated retention period before the first one is written, not afterwards.",
		"**Payment information.** If you give monthly support or buy something, **your card details go directly to Stripe and never touch our servers.** We keep a record of the transaction: what was bought, the amounts, the fees, sales tax, and Stripe's identifier for the payment.",
		"**Safety information.** If you report content or someone, or if something of yours is reported, we keep a record of the report, the decision, and who made it.",
		"**Copyright notices — the one place we hold a full postal identity.** If you file a copyright notice against something published here, we keep your name, postal address, email address and telephone number, your description of the work and of the material you say infringes it, and the exact wording of the statements you agreed to at the version you were shown them. **You do not need an account to file one**, so for a complainant this may be the only thing we ever hold about you — and it is more identifying than anything we hold about an ordinary reader. The law requires each of those elements; a notice missing them is not a notice.",
		"**If your work is taken down and you answer**, a counter-notice requires your legal name, postal address and telephone number and your consent to federal jurisdiction, and **we are required to forward all of it to the person who filed the notice.** That is a disclosure to another person rather than to a service provider, and it is not something we can decline to do. It is why our [copyright page](/copyright) states what a counter-notice exposes before you fill anything in.",
		"**Linked accounts.** If you connect a Bluesky or other ATProto identity, we store the tokens needed to maintain that connection, and your handle and identifier.",

		"## What we don't collect",
		"No advertising identifiers. No analytics service. No third-party tracking pixels. No data brokers, in either direction.",
		"**Anthers loads no fonts, scripts, or embeds from anyone else's servers** — everything the site needs, it serves itself, so that reading, watching or browsing here tells nobody but us that you did. The **one** exception is the payment processor's own software on the pages where you are paying, described below. We would rather name a single exception than write a sentence that is nearly true.",
		"**We do not build a device fingerprint of you, and we do not let our payment processor do it either.** We considered it for ourselves as a defense against fraudulent card disputes and decided against it. Stripe offers its customers an optional layer that examines your device and your behavior on the page — screen and browser characteristics, mouse movement, how long you spend, whether a card number was typed or pasted. **We have that switched off.** Stripe says turning it off raises our exposure to fraud, and we accepted that, because paying here already requires an account with a confirmed email address rather than an open form anyone can hammer.",
		"**Two things stay on, so this is not an unqualified claim.** Stripe still sees what you type into its own card fields, which is how the card form works at all. And if your bank asks you to confirm a payment, basic information about your device goes to your bank as part of that check — your bank requires it and we cannot switch it off. Neither builds a profile that follows you around the site.",
		"If we ever turn that fraud layer back on, this section changes in the same breath. It is a lever we have deliberately left down, not a promise we can keep while quietly reaching for it.",

		"## What creators can see",
		"Creators receive analytics about their own work: how many people viewed it, total time spent, and trends over time.",
		"**Creators never see who watched what.** Analytics are aggregated by Work and by date, and your identity is never part of them. A creator can see that a Work was watched for forty hours; they cannot see that it was watched by you. This is a design commitment rather than a current limitation, and there is a test that fails if anyone changes it.",

		"## Who we share it with",
		"We share personal information only with service providers who process it **on our instructions**, only for the purposes below, and never for their own:",
		"- **Cloudflare** — your IP address, browser user-agent and request headers, for every request, plus **everything you upload**: your files, images, video and audio are stored on Cloudflare R2. DNS, DDoS protection, and filtering automated traffic. Every request to Anthers passes through Cloudflare before it reaches us.\n- **DigitalOcean** — application hosting and the database.\n- **Stripe** — card details, and payment and payout records. Stripe's optional device-examination layer is switched off, so what it receives is what you enter on the payment page rather than a picture of your device.\n- **Resend** — your email address and the contents of the email we send you.",
		"**Checking uploads against known child sexual abuse material sends a fingerprint, never your file.** We calculate a **perceptual hash** — a short mathematical fingerprint, not the picture — and send only that to the **Canadian Centre for Child Protection**, which tells us whether it matches known material. Images are checked directly; a video is sampled into still frames and each frame is checked the same way. **Your files themselves never leave Anthers for this, and neither does anything that would let the Centre fetch them.** A fingerprint that does not match, which is nearly all of them, tells them nothing whatsoever about you or what you uploaded. **Audio is not covered**, because the fingerprint describes a picture and there is nothing in a sound for it to describe.",
		"**The Centre is not one of our service providers, and that difference is worth stating rather than burying.** Everyone in the list above works on our instructions and for our purposes. The Centre is an independent organization pursuing its own child-protection purpose, and under our agreement each of us decides independently what to do with what we hold — so it does not belong in that list, and adding it there would make the sentence above it untrue. What it receives from us is the fingerprint and nothing else.",
		"**One disclosure goes to another person rather than to a provider, and the law requires it.** If your work is removed after a copyright notice and you file a counter-notice, **we forward your legal name, postal address and telephone number to the person who filed the notice**, along with your consent to federal jurisdiction. We cannot run the process without doing that — it is what a counter-notice is under the law, and a provider who withheld it would not be forwarding a counter-notice at all. The reverse holds in a smaller way: when we act on a notice, the creator is told **who filed it**, because being accused without being told by whom is not a process anyone can answer. This is the one place on Anthers where using a feature discloses your home address to another user, and our [copyright page](/copyright) says so before the form rather than beside the submit button.",
		"We may also disclose information **where we are legally compelled to** — a valid court order, subpoena, or equivalent legal process. We check that the demand is genuine and that it reaches what it claims to reach, and we produce the least it compels rather than the most it asks for. **Where we are permitted to tell you, we will, and we tell you before we produce anything**, so that you have the chance to object on your own behalf. Where a court forbids us to tell you, that prohibition has an end date; we record it, and we tell you when it lapses.",
		"We publish **aggregate, anonymized** figures — totals, trends, charitable transparency reporting — which cannot be traced to any individual.",
		"**We have never sold personal information and will not.** Under California law, we do not “sell” or “share” personal information as those terms are defined.",

		"## Cookies",
		"**There is no cookie banner on Anthers, because there is nothing to ask you about.** We use no advertising, analytics, or tracking cookies — the kind consent banners exist for. Every cookie here is one the site cannot work without, and the law that requires those banners exempts exactly these.",
		"- **Our session cookie** keeps you signed in. Without it, every page would ask you to sign in again.\n- **`__cf_bm`** (Cloudflare) tells automated traffic from real visitors, so the site stays up under attack. 30 minutes.\n- **`__stripe_mid` and `__stripe_sid`** (Stripe) are fraud prevention, and are **set only if you reach a payment page** — browsing, reading, watching and playing set neither. With Stripe's device-examination layer switched off they may not be set at all; they are listed because we would rather name a cookie you never receive than omit one you do.",
		"We also store a few settings in your browser rather than on our servers — your light/dark preference, for instance. Those never leave your device.",

		"## How long we keep it",
		"**Your account and content:** as long as your account exists.",
		"**Viewing history:** raw records connecting *you* to a specific Work are kept for **180 days**, which covers the billing cycle they belong to and the card-dispute window that follows it. After that they are aggregated into per-Work and per-creator totals and **the per-person records are deleted.** Creators keep their earnings history; a complete history of what you personally watched stops existing.",
		"One record survives that, and it is a payment record rather than a viewing one. So that creators can be paid, we keep — for as long as financial records must be kept — a per-month total of how much time you spent with *each creator* you supported. It never says which of their works you spent it on. That is the difference the paragraph above turns on: what stops existing is the record of **what** you watched, not the fact that you supported someone.",
		"**Sessions:** deleted when they expire.",
		"**Sign-in codes:** a code stops working after ten minutes. The record is deleted the moment it is used, and otherwise by a daily sweep — so an unused one is dead long before it is gone. Nothing else is kept: if you never finish, no account is created.",
		"**Payment records:** kept as long as tax, accounting, and nonprofit reporting law requires, which is longer than your account may exist and is not a period we can choose.",
		"**Safety and copyright records** — reports, copyright notices, and the decisions we made about them — work differently from everything above, and the difference is worth stating plainly rather than burying in a number. **The record is permanent. The personal detail in it is not.**",
		"- **We keep the record itself indefinitely** — that a report was made, what it claimed, what we decided, and what happened to the work. It outlives the content and both accounts. If a decision could simply be erased, *“why was my comment removed?”* would have no honest answer and an appeal would be impossible. For copyright there is a second reason: the law requires us to have a policy for ending the accounts of repeat infringers, and **a record the accused person can erase — by deleting the work — is not a record.**\n- **After three years we delete the personal details from it.** For a copyright notice that is the sender's name, postal address, telephone number and email, and — if the creator answered — the same four things about them. For a report it is the reporter's own words and the link to who they were. Everything else stays, permanently redacted rather than deleted, so what survives is *what happened* without *who to contact about it*.\n- **Three years, counted from the last thing that happened to the record**, not from when it arrived — so letting something sit does not run the clock down.\n- **Why three:** it is how long somebody could still bring a copyright claim, or a claim that a notice was filed dishonestly, in either direction. The details survive exactly as long as somebody could still need them in court, and no longer.\n- **A live court case stops the clock.** If either side has gone to court over a notice, nothing about it is deleted while that is true.",
		"Two things this deliberately does not cover, said so that their absence is a decision rather than a gap. **Our own record of the decision** — the operator, the date, the reason, our internal note — is never redacted: it holds nobody else's contact details and it is the thing that answers the appeal. And **IP addresses** are not part of this at all; the only ones we hold sit on sign-in sessions and go when the session expires, as above.",
		"**What we publish about all of this is counts, not notices.** Totals — how many notices we received, acted on, rejected, how many were answered, how many works came back — are on the [copyright page](/copyright). We do not publish the notices themselves: publishing one would publish the sender's home address and identify the creator it named, and doing that by default is a decision about other people's privacy we are not willing to make on their behalf.",

		"## Your rights",
		"These rights are extended to everyone who uses Anthers, wherever you live.",
		"- **Know** what we hold about you and why — this document, and on request the specifics.\n- **Get a copy** of your information and your content, in an openly readable format. It's in your settings, and it's immediate.\n- **Correct** anything inaccurate — most of it directly in your settings.\n- **Delete** your account and content — see below.\n- **Object** to a particular use, and ask us to stop.\n- **Complain** to your data protection authority, if you are somewhere that has one.",
		"**What the copy of your data deliberately leaves out**, so that it is a decision rather than an omission you discover: your password and your session tokens, so that nothing in the file can be used to sign in as you; and anything that is somebody else's, including reports other people made about you, which would identify them.",
		"We will not charge you for exercising these, and we will not treat you differently for it.",
		"Two of them are buttons rather than requests: **downloading your data** and **deleting your account** both happen in [your settings](/settings), without asking us. For anything else, email us and we will respond **within 30 days**.",

		"## What happens when you delete your account",
		"Deleting is **scheduled, not instant**: you have **seven days** to change your mind, and signing back in is all it takes to cancel. Confirming signs you out of every device straight away. We show you exactly what will happen to your things — with the actual counts from your account — before you confirm, because a warning you can't check isn't consent.",
		"We do not keep anything *because* a deletion is pending. The week is a grace period, not an archive.",
		"**Deleted outright:** your profile, email address, password, sessions, linked identities, follows, bookmarks, blocks, and viewing history — **including your avatar and header image, and the stored files of any Work nobody bought**.",
		"**Your comments and posts become anonymous rather than disappearing.** They're marked as deleted by their author, and your name comes off them. Conversations other people took part in stay readable — a thread full of holes is worse for everyone still in it, and replies to a removed comment would otherwise make no sense. If a specific comment or post contains information you need actually removed, tell us and we will remove it.",
		"**Your reviews become anonymous.** The score stays in a creator's average; the connection to you is deleted. Removing it outright would move a creator's rating through no fault of theirs.",
		"**Your Works that nobody has bought are deleted.**",
		"**Your Works that people have bought are withdrawn rather than deleted** — they leave public circulation and stay available to the people who paid for them, for the notice period described in the [Terms of Service](/terms), after which they are removed from our servers. We email each of those buyers when it happens, so they can download a copy they keep.",
		"**Payment and safety records remain**, as described above — but **your name comes off the payment ones.** We're required to keep a record of what was sold and what sales tax was collected on it; we're not required to keep a record of *who bought it*, so the transaction survives with you detached from it. There is no route back from it to you.",

		"## Young people",
		"**You have to be 13 or older to have an Anthers account.** We do not knowingly collect information from anyone under 13, and if we learn that we have, we delete it. There is no under-13 account and no plan for one — if we ever build something for younger children, it will be a separate service built for them, not a filtered corner of this one.",
		"**We don't ask your age, and we don't verify it.** That is deliberate. Verifying age properly means collecting identity documents or dates of birth from everyone, and we are not willing to hold that about you in order to check a fact about a few. It means someone under 13 could sign up by not telling us — we would rather say that plainly than claim a protection we don't have.",
		"**Content made for young audiences is free, and funded by us**, never advertising and never engagement-optimized. There is no advertising anywhere on Anthers and no mechanism anywhere that profits from anyone's attention, at any age.",
		"Some things about this service are worth a parent knowing, and they're set out in plain language on our [page for parents and guardians](/parents) rather than buried here.",

		"## Security",
		"Passwords are hashed with argon2id. Sessions are opaque tokens you can review and revoke. Purchased and gated media is stored privately and every link to it is generated per request, after re-checking that you're allowed to have it. Card details never reach our servers.",
		"No system is perfectly secure, and we will tell you promptly if something happens that affects you.",

		"## Changes",
		"If we change this policy in a way that materially affects your rights, we will tell you before it takes effect — not by quietly updating a date at the bottom. We email you, and we keep a record that we did, so this is a promise with evidence behind it rather than an intention.",
	],
};

const TERMS: LegalDocument = {
	title: "Terms of Service",
	summary: "The agreement between you and Anthers, Inc.",
	effectiveDate: null,
	blocks: [
		"These are the terms for using Anthers as a person — reading, watching, playing, commenting, supporting creators, and buying things. If you publish work here, the [Creator Terms](/creator-terms) apply on top of these.",
		"We've tried to write these so you can actually read them. Where something is a genuine legal requirement we've said so plainly rather than burying it.",

		"## Who we are",
		"Anthers is operated by **Anthers, Inc.**, a Colorado nonprofit corporation. These terms are governed by Colorado law.",

		"## Who can use Anthers",
		"**You have to be 13 or older.** We don't ask your age and we don't verify it — see the [Privacy Policy](/privacy) for why — so this is a rule you're agreeing to keep rather than one we check.",
		"You're responsible for what happens under your account, and for keeping your password to yourself. You can close your account at any time.",
		"**Publishing work is different, and it does require verification.** To publish anything on Anthers you have to complete payout setup, which means our payments provider confirms your identity and that you are an adult. Two consequences worth stating plainly: **people under 18 cannot publish here**, and at launch **creators must be in a country our payments provider can reach.** Both are covered in the [Creator Terms](/creator-terms).",

		"## What you can expect from us",
		"Anthers is a nonprofit. **We take no cut of what you give creators** — the only deduction on monthly support or a purchase is the card processing that the payment network charges, which goes to the processor and not to us.",
		"We'll keep the platform running as well as we reasonably can, and we'll tell you before we make a change that materially affects your rights.",
		"**We won't sell your data, show you advertising, or optimize anything here to consume more of your attention.**",

		"## What we expect from you",
		"Don't post things that are illegal, that harass or threaten people, that sexualise minors in any way, or that you don't have the right to post. Don't try to break, overload, or get around the access controls on other people's work.",
		"If you break these, we may hide the content, or in serious cases end your account. We keep a record of what we did and why, so that if you ask, you get an honest answer.",
		"**If something is removed, we say so rather than making it silently vanish** — content shows whether it was removed by its author or by moderation. We do not publish the reason, because doing so would make a public accusation out of a moderation decision, and would risk exposing whoever reported it.",

		"## Copyright, and repeat infringement",
		"Don't post work you don't have the rights to. If you do, the person who owns it can ask us to take it down, and we will.",
		"**If you own a copyright and someone here is infringing it**, our [copyright page](/copyright) has our designated agent's details and how to file a formal notice. A report through the ordinary reporting button is **not** a copyright notice and can't be treated as one — copyright ownership is a claim about the world, made under penalty of perjury, with legal requirements we can't meet on your behalf. If you file a report that turns out to be a copyright claim, we'll tell you and point you at the right path rather than acting on the report.",
		"**We end the accounts of users who repeatedly infringe copyright, in appropriate circumstances.** That's a condition of the legal protection that lets us host anyone's work at all, and this is where we tell you about it.",
		"- **A person decides, every time.** There's no automatic strike counter. A notice is not a finding, and an automatic counter turns a bad-faith notice into an instant penalty — which is what makes copyright takedown a weapon on other platforms.\n- **We publish no number.** A stated threshold invites gaming from both directions, and the law asks for none. What counts as “appropriate circumstances” is a judgment about a pattern: how many notices, whether they were valid, whether they were answered, and whether anything changed.\n- **You can ask, and you can appeal.** The decision is recorded, so *“why?”* has an answer.\n- **A notice you successfully answer isn't held against you.** If you file a counter-notice and the work comes back, none of it counts toward anything.",
		"We publish counts of what this process has actually done — notices received, acted on, rejected, answered, restored — on the [copyright page](/copyright). We don't publish the notices themselves, because that would publish the sender's home address and identify the creator they named.",

		"## Blocking and reporting",
		"You can block anyone. A block is symmetric — neither of you will see the other around Anthers — and it takes effect immediately without anybody reviewing it. It's your boundary, not a complaint.",
		"You can also report content or a person, which is different: that asks a human to look. We don't tell you what happened to an individual report.",

		"## Money",
		"**Monthly support** is an amount you choose, and you choose who it goes to. What you give a creator goes to that creator; what you give Anthers funds the pool that pays creators by the time you spend, pays its share of card processing at cost, and what's left funds free access and our charitable programs.",
		"**Support recurs monthly until you change it.** You can stop at any time, and you keep what you have paid for through the cycle you have already paid for. We do not pro-rate a cycle in progress.",
		"**Direct purchases** are one-off. You pay the price the creator set, plus sales tax where it applies, and nothing else.",
		"Prices shown include every mandatory fee. Sales tax is the only thing added at checkout.",

		"## Refunds",
		"**Ask us and we will refund you.** We'd rather return your money quickly than argue about whether you deserve it back, and we don't make you justify yourself. Email us.",
		"**Digital things are different once you've downloaded them**, and we'd rather explain that than pretend otherwise: we can't un-send a file, and the card processing cost isn't returned to us when we refund you. So refunds after download are **automatic for your first three in any twelve months**, and after that we'll want to talk to you before issuing another. That is not a trap — almost nobody reaches it, and if you do and it's genuine, we'll still sort it out.",
		"**Here's where that money actually comes from**, because it's the honest reason for the limit rather than a policy we're hiding behind: Anthers keeps nothing from a sale, so a refund can't come out of a platform margin we don't have. It comes out of the same pool that pays for free access for people who can't pay. **Refund abuse is not paid for by us. It is paid for by them.**",
		"Refunding something you never downloaded doesn't count against that at all.",
		"**None of this applies when the problem is ours or the creator's.** If a Work is taken down, if something never worked, or if you were charged for something you didn't buy, you're refunded regardless of downloads, and it doesn't count against anything.",

		"## What you own, and what you let us do",
		"**You keep full ownership of everything you put on Anthers** — your posts, your comments, anything you upload. Nothing here transfers copyright, and we claim no ownership of it.",
		"You give us the permission we need to actually run the service: to store what you post, to convert it into formats that display in a browser, and to show it to the people you posted it for. **That permission is limited to operating Anthers, it is not exclusive, and it ends when you remove what you posted** — except where someone has already bought something, which is covered below.",
		"We will not use it to advertise anything, and will not license it to anyone else.",
		"**Anthers does not use your work, or anything you do here, to train machine-learning models.** This is a commitment about what *the platform* does, and it does not expire.",
		"It is not a claim about every piece of software distributed on Anthers. A creator may publish a game or application that uses data from the people who play it — for personalization, analytics, or anything else — and if they do, **they have to tell you.** That is their software's behavior, not ours, and you get to decide whether to use it. What we guarantee is that Anthers itself is never the thing doing it.",

		"## What you buy, you keep",
		"**This is the most important commitment in this document.** When you buy a Work, **it stays in your library, regardless of what the creator does afterwards.** A creator cannot take back something you have already paid for.",
		"If a creator later removes a Work you own, it disappears from public view but **stays available to you**. **We tell you it is going**, and give you **90 days from the day it is withdrawn** to download it — everyone gets the same deadline, counted from the same day. Downloading it during that period is free, as every download is. After that period it is removed from our servers, and anything you downloaded is yours to keep permanently.",
		"We do this rather than storing removed work forever because a creator who has left should not be charged indefinitely for storage, and the nonprofit should not absorb that cost indefinitely either. The notice period exists so that nobody loses what they paid for.",
		"**If a Work changes substantially**, you get the current version, and the same notice and free-download window apply.",
		"**The first exception is a takedown the creator asks for.** If a creator must remove work for a legal or safety reason — they lost the rights to something in it, it exposes them to harm, or a court requires it — it is removed **immediately, without a notice period, and you are refunded.** We keep this narrow and separate from ordinary removal on purpose.",
		"**The second exception is a copyright takedown, and it is the only case where somebody other than you or the creator can end your purchase.** If a copyright owner files a valid notice against a Work you bought, we have to remove it — and unlike ordinary removal, that means removing it **from your library too**, not just from public view. Continuing to deliver work we have been told infringes would be continuing to infringe, so this is not a promise we are able to keep. **We refund you in full**, and it never counts against your refund limit — it wasn't your decision.",
		"The refund comes when the removal is **final**, not the moment it happens: the creator has ten business days to answer the notice, and a work that comes back was never a sale that should have been undone. If they do answer and it's restored, it goes back on sale rather than back into your library — your money has already come back to you, and buying it again is your choice. The whole process is on our [copyright page](/copyright).",

		"## Ending things",
		"You can delete your account at any time, from your settings. It takes effect after seven days, and signing back in during that week cancels it.",
		"We can suspend or end your account if you seriously or repeatedly break these terms. If we do, **anything you have bought remains yours**, and we will tell you why.",

		"## The honest disclaimers",
		"Anthers is provided as-is. We work hard to keep it running and your work safe, but we cannot promise it will never be unavailable or that nothing will ever go wrong. **Keep your own copies of work that matters to you** — that is good advice from anyone, and we would rather say it than imply otherwise.",
		"Our liability is limited to what you have paid us in the past twelve months. Nothing here limits liability we cannot limit by law.",

		"## If we disagree",
		"Most problems get solved by telling us about them, and we would rather fix something than argue about it. **Contact us first** — we commit to a real response within 30 days, from a person.",
		"If that doesn't resolve it, disputes are settled by individual arbitration in Colorado, under Colorado law. We have deliberately written this the narrow way, and here is exactly what we have kept out of it:",
		"- **You can always go to small claims court instead.** For most disputes with us that is the cheaper and faster option, and nothing here takes it away.\n- **You can still ask a court to make us stop doing something.** Claims for injunctive relief are not covered.\n- **You can opt out entirely.** Tell us within 30 days of accepting these terms and this section does not apply to you, with no effect on anything else.\n- **We pay the arbitration costs.** A dispute-resolution process you cannot afford to use is not a process, and we are not going to price you out of holding us to these terms.",
		"**You are not giving up the right to join a class action; we haven't asked you to.**",
		"We are aware that arbitration clauses are usually a way for a platform to make itself hard to hold accountable. That is not what this is for, and the carve-outs above are how we intend to prove it. It exists because a small nonprofit can be ended by a single mass claim, and the platform ending is worse for everyone here than any dispute it would have resolved.",

		"## Changing these terms",
		"We will need to change these terms over time. Here is how that works, and it is a commitment in itself:",
		"- **For any change that materially affects your rights, we tell you at least 30 days before it takes effect** — by email and in the app, not by quietly editing a date at the bottom of a page.\n- **We say what changed and why**, in plain language, not just a link to a new version.\n- **You can tell us it's a problem.** During the notice period we want to hear it, and we would rather amend a bad change than defend it.\n- **If you don't want to continue under the new terms, you can close your account** — and anything you have already bought stays yours regardless.\n- **Changes are not retroactive.** A change to these terms cannot take away something you already bought, or alter the terms a purchase was made under.",
		"Minor changes — fixing a broken link, clarifying wording that doesn't change what it means — we make without the notice period, and we keep a public history of every version.",
	],
};

const CREATOR_TERMS: LegalDocument = {
	title: "Creator Terms",
	summary: "Additional terms if you publish work on Anthers.",
	effectiveDate: null,
	blocks: [
		"These apply **in addition to** the [Terms of Service](/terms) if you publish work on Anthers. Everything there still applies to you as a person using the platform, unchanged — we are not asking you to accept a harsher version of any of it because you make things.",
		"Where the two documents cover the same ground, they say the same thing. If they ever appear not to, tell us — that is a mistake on our side, not a choice you have to interpret.",

		"## Two things to know before you start",
		"**You have to be able to be paid before you can publish** — even for work you intend to give away free. Setting up payouts means our payments provider verifies your identity, and that is the only check standing between an account and a published Work.",
		"We do it this way because on Anthers **everything can earn.** We don't reserve monetization for creators above some follower threshold the way other platforms do; free, public work earns from the pool like anything else. So being payout-ready isn't a hurdle placed in front of a privilege — it's finishing the setup for something you already have.",
		"**You must be an adult.** People under 18 cannot publish on Anthers. This is not a judgment about young people's work — it is that the alternative, where an adult holds the money for a minor's labor, creates a relationship we are not willing to build. If that rules you out, we would rather say so now than after you have put work into this.",
		"**At launch, you must be somewhere our payments provider reaches** — currently the US, UK, Canada, Switzerland and the EEA. We are not comfortable with this and do not intend to keep it: *“we can't pay you in your country yet”* is an ordinary limitation, but *“you can't publish here”* is a different thing, and separating the two is on our roadmap.",

		"## Your work stays yours",
		"**You keep full ownership of everything you publish.** Nothing here transfers copyright, and Anthers claims no ownership of your work — not of the work itself, not of your catalog, not of anything you make with the tools we provide.",
		"To actually run the service, you give us permission to do a specific and limited set of things with what you upload:",
		"- **Store it**, and keep the copies and backups that hosting requires.\n- **Convert it** into the formats that play in a browser or on a phone — transcoding video, normalizing audio, generating thumbnails, waveforms and previews.\n- **Deliver it** to the people you have made it available to, on the terms you set.\n- **Show it where it belongs** — your catalog, your profile, the feeds of people who follow you, and the parts of Anthers where work is discovered.",
		"That permission exists so that we can operate Anthers, and for nothing else. It is **not exclusive** — publishing here never stops you publishing anywhere else — and it **ends when you remove the work**, with one exception: people who have already bought it, set out under *If you remove work someone bought* below.",
		"**We will not license your work to anyone else, sell it, or use it to advertise anything.** And, as in the general terms: **Anthers does not use your work to train machine-learning models.** That is a commitment about what the platform does, and it does not expire.",
		"You're responsible for having the rights to everything you publish, including music, art, and code you didn't make yourself.",

		"## What Anthers takes",
		"**Nothing.** There is no platform fee, no commission, and no cut of what you earn — not on support given to you, not on a direct sale, not on anything.",
		"What *is* deducted is money that never reaches us: **card processing**, which goes to the payment processor. Accepting a card costs money; that cost comes out of the payment rather than being added on top of it, because the law requires an advertised price to contain every mandatory fee. That is the whole list — delivery costs Anthers nothing, so nothing is deducted for it, and your buyers can download what they bought as many times as they like, on as many devices as they like, for as long as it exists.",
		"Card processing is shown to you, at cost, wherever you are making a decision that depends on it. **We would rather show you an itemized deduction you can check than a round number you have to trust.**",

		"## How you get paid",
		"Money reaches you three ways, and which one applies depends on **who distributed the work** — meaning who set the terms the audience reached it on, not who stored the file.",
		"**Support given to you.** Somebody gives you a monthly amount — whatever they choose — and it comes to you, less its share of card processing. It recurs until they change it, and it clears whatever Badges you have set at or below that amount.",
		"**The pool.** Work you leave **ungated** — free to everyone, with nothing to clear — is paid out of the pool funded by what people give Anthers, shared among creators in proportion to the time people spent with their work. A minute is a minute, whether it was played, watched, read or listened to. Free accounts count too — Anthers pays a smaller amount on their behalf, split by exactly the same rule, so someone enjoying your work without paying still pays you.",
		"**Direct sales.** You set a price, someone pays it, and the money is yours less card processing.",
		"Work *you* distribute — behind your own gate, or sold directly — is paid for by the people supporting you directly, and does not draw from the pool. Work *Anthers* distributes is paid from the pool. Each piece of work is paid for once, by the side that carried it. **Hosting your own files does not change this**: if Anthers still sets the terms your audience reaches the work on, it still earns from the pool.",
		"Work hosted somewhere else entirely — a video on another platform, linked from a post — earns nothing here, because that platform controls who reaches it and on what terms. You are free to link to anything; we simply cannot pay you for an audience we did not serve.",
		"**Payouts run through Stripe**, which verifies your identity, holds your bank details, and sends the money, on their schedule. Because that verification is also what lets you publish at all, it happens before your first Work rather than after your first sale.",

		"## Setting your prices and your gates",
		"**You set the price a buyer sees**, and we show you what you will receive before you commit to it. The figure we show is the single-item worst case — a buyer who puts several things in one basket pays one card fee across all of them, and **the whole of that saving goes to you.**",
		"**You set your own Badges** — the amount someone must be giving you each month to reach a given piece of work, at whatever amounts you choose, each with a Badge you design and name. You decide what each one carries.",
		"Prices and gates apply from when you set them. **Changing them does not reach back**: someone who already bought something, or who already holds a Badge for the cycle they have paid for, keeps what they had.",

		"## Storage",
		"**You pay for storing your own work. Nobody pays for delivering it.** Your first 50 GiB is free. Above that, storage is charged at our storage provider's rate plus half again — and that half is not profit, it is what funds free access and Anthers' charitable programs.",
		"We will tell you before a change to your storage costs takes effect, and you will always be able to see what you are using.",

		"## Tax",
		"**You are responsible for your own taxes on what you earn here.** We are not your employer, and nothing in this relationship makes you an employee of Anthers. Stripe issues the US tax forms it is required to issue for the accounts it manages, and we report what we are required to report.",
		"**Sales tax on your sales is ours to handle, not yours.** Where tax is owed on something sold through Anthers, we collect it from the buyer and remit it. This follows from marketplace-facilitator law and is unaffected by Anthers being a nonprofit — a charitable exemption covers what an organization buys, not what it sells.",

		"## If you remove work someone bought",
		"You can remove your work from Anthers at any time. **What you cannot do is take back something a person has already paid for**, and you should read this section before you price anything, because it binds you as much as it binds us.",
		"When you remove a Work nobody has bought, it is simply gone. When you remove a Work **someone has bought**:",
		"- It leaves public view immediately. Nobody new can find it or buy it.\n- **It stays available to the people who already own it for 90 days**, counted from the day you withdraw it, so they can download what they paid for.\n- **That download costs nobody anything** — not the buyer, not you, not Anthers. Delivery is free, so rescuing what you already own is simply a download like any other.\n- After the notice period it is removed for real, and their receipt remains.",
		"This is the other side of the commitment the general terms make to buyers: *what you buy, you keep*. We are not willing to make that promise to a reader and then let it be undone from this side. Equally, we are not going to charge you storage forever for work you asked to be rid of — which is what the notice period is for. It ends, and then the obligation ends with it.",
		"If you close your account, the same applies to everything you've sold.",

		"## Takedown is a different thing, and it is fast",
		"Sometimes work has to be **gone**, not wound down — you have lost the rights to something in it, it is being used to harm you, someone is being exposed by it, or a court has ordered it.",
		"That is a **takedown request**, not a removal, and it works differently: you tell us, we review it quickly, and on approval **the work is removed immediately, with no notice period, and the people who bought it are refunded.**",
		"We keep this deliberately narrow and deliberately separate. A creator under real pressure should not have to choose between their own safety and a promise we made to someone else, and without a named path for it that choice would land on whoever happened to be on call.",

		"## When somebody else asks for your work to come down",
		"The takedown above is the one **you** ask for. This is the other one, and it's worth reading before it happens rather than after.",
		"If a copyright owner files a valid notice against something you published, we remove it. A person reviews every notice and nothing is automated — but the law asks us to act *promptly*, so **the removal comes first and the argument comes after.** We don't hold a notice for a day to hear from you first, because that's the one design that would cost us the legal protection this whole process exists to keep.",
		"- **The work stops being delivered to everyone, including the people who bought it**, and those buyers are refunded. Continuing to serve it would be continuing to infringe.\n- **We tell you straight away**, with the reason, who filed it, and how to answer.\n- **One notice takes down the work it named.** Never your catalog, never your account, never everything you've published. We consider this the single most important limit on the process — a takedown that could sweep a catalog is a competitor-removal tool.\n- **You can file a counter-notice**, and if you do, the work goes back up in ten to fourteen business days unless the person who filed takes you to court.",
		"**Read this before you counter-notice, because it's the part nobody tells you.** A counter-notice requires your **legal name, postal address and telephone number**, and your **consent to be sued in federal court** where you live — and **those details are forwarded to the person who filed the notice.** If you publish under a name that isn't your own, a counter-notice isn't simply a remedy: it hands your accuser your identity and your address. It may still be the right choice. It should be an informed one.",
		"**If you agree the notice was right, you can say so** and settle it — your buyers are refunded straight away rather than waiting out a clock whose answer both sides already know. Conceding costs you nothing you hadn't already lost, and waives nothing.",
		"**If you don't answer within ten business days**, we treat the removal as final and refund the buyers. You can still file a counter-notice after that and we'll still restore the work — the deadline governs when the money is settled, never whether you're allowed to answer.",
		"**Repeatedly infringing copyright can end your account.** That's in the [Terms of Service](/terms), along with the two things that matter most about how we run it: a person decides every time, and we publish no strike number. Everything here, including our designated agent's details, is on the [copyright page](/copyright).",

		"## What you publish",
		"The rules in the general terms apply to your work as much as to anything else on Anthers: nothing illegal, nothing that is not yours to publish, nothing aimed at harassing people.",
		"**Say when your work is not what it appears to be.** Where a Work is generated rather than made, or presents itself as something it is not, say so.",
		"**If your software collects data from the people who use it, tell them.** Anthers itself never uses anyone's data to train machine-learning models, and never will. That is a promise about the platform, and it is not one we can make on behalf of every game and application published here. You may build software that uses player data — for personalization, for analytics, for whatever your work needs — and if you do, **you have to say so plainly**, so that the person deciding whether to play it is deciding with the facts.",

		"## Moderation of your work",
		"We may hide content that breaks the Terms of Service. Removal is always a recorded decision rather than a deletion, so you can ask what happened and get a real answer.",
		"**You will not be given authority over reviews of your own work.** A review is a reader's verdict, and letting the person being judged remove the judgment is the exact conflict reviews exist to avoid. Moderation of your community's comments is a different matter, and is something you can be entrusted with.",

		"## Ending things",
		"You can stop publishing at any time. Your obligations to people who already paid you survive that, as described above.",
		"We can also stop someone being a creator here, for the reasons set out in the general terms. If we do:",
		"- **You are paid what you have already earned.** Ending your account is not a way for Anthers to keep money — there is none of yours that we hold as ours.\n- **Everything anyone bought from you stays theirs**, and the obligations under *If you remove work someone bought* still run.\n- **We tell you why.**",

		"## Changing these terms",
		"These terms change the same way the general terms do, with the same 30 days' notice, the same plain-language explanation of what changed and why, and the same commitment that **changes are not retroactive** — a change here cannot alter the terms a sale was made under, or take back something someone already bought from you.",
	],
};

export const LEGAL_DOCUMENTS: Record<string, LegalDocument> = {
	privacy: PRIVACY,
	terms: TERMS,
	"creator-terms": CREATOR_TERMS,
};
