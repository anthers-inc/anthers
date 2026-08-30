// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The published text of the legal documents.
 *
 * **Canonical text lives in the vault**, in `51.01 Published Terms` — the Privacy Policy,
 * the Terms of Service and the Creator Terms. This is the rendered copy with the internal
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
		"**Information you give us.** Your email address and username, and a password if you set one — passwords are optional here, and are stored only as a cryptographic hash, so we never hold your actual password. Optionally: a display name, bio, avatar, header image, website, and location. All optional fields are free text you choose, and anything you put in them is public.",
		"**A sign-in code, briefly, before there is an account.** When you start an account or sign in by email, we email you a six-character code and hold it — hashed, never in readable form — against that address for **ten minutes**, with a count of how many times it has been tried. Nothing else: no IP address, no name, and if you never finish, no account is created. See *How long we keep it*.",
		"**Information created by using Anthers.** Your posts, Works, comments, reviews, follows, bookmarks, and projects.",
		"**What you view, and for how long.** When you play, watch, read, or listen to a Work, we record that it happened, which Work it was, and for how long. **We have to**: this is how creators get paid by time, and there is no way to pay someone for the time you spend with their work without recording the time you spend with their work. See *How long we keep it* below.",
		"**Technical information.** Your IP address and browser user-agent, recorded with each sign-in session so you can review and revoke your own sessions and so we can investigate abuse.",
		"**Payment information.** If you give monthly support or buy something, **your card details go directly to Stripe and never touch our servers.** We keep a record of the transaction: what was bought, the amounts, the fees, sales tax, and Stripe's identifier for the payment.",
		"**Safety information.** If you report content or someone, or if something of yours is reported, we keep a record of the report, the decision, and who made it.",
		"**Copyright notices — the one place we hold a full postal identity.** If you file a copyright notice against something published here, we keep your name, postal address, email address and telephone number, your description of the work and of the material you say infringes it, and the exact wording of the statements you agreed to at the version you were shown them. **You do not need an account to file one**, so for a complainant this may be the only thing we ever hold about you — and it is more identifying than anything we hold about an ordinary reader. The law requires each of those elements; a notice missing them is not a notice.",
		"**If your work is taken down and you answer**, a counter-notice requires your legal name, postal address and telephone number and your consent to federal jurisdiction, and **we are required to forward all of it to the person who filed the notice.** That is a disclosure to another person rather than to a service provider, and it is not something we can decline to do. It is why our [copyright page](/copyright) states what a counter-notice exposes before you fill anything in.",
		"**Linked accounts.** If you connect a Bluesky or other ATProto identity, we store the tokens needed to maintain that connection, and your handle and identifier.",

		"## What we don't collect",
		"No advertising identifiers. No analytics service. No third-party tracking pixels. No data brokers, in either direction.",
		"**Anthers loads no fonts, scripts, or embeds from anyone else's servers** — everything the site needs, it serves itself, so that reading, watching or browsing here tells nobody but us that you did. The **one** exception is the payment processor's own software on the pages where you are paying, described below. We would rather name a single exception than write a sentence that is nearly true.",
		"**We do not build a device fingerprint of you.** We considered it as a defense against fraudulent card disputes and decided against it. The one exception is not ours and we won't pretend otherwise — **Stripe inspects your device and browser on our payment pages** as part of checking that a card is being used by the person entitled to use it. That is confined to the pages where you are paying.",

		"## What creators can see",
		"Creators receive analytics about their own work: how many people viewed it, total time spent, and trends over time.",
		"**Creators never see who watched what.** Analytics are aggregated by Work and by date, and your identity is never part of them. A creator can see that a Work was watched for forty hours; they cannot see that it was watched by you. This is a design commitment rather than a current limitation, and there is a test that fails if anyone changes it.",

		"## Who we share it with",
		"We share personal information only with service providers who process it **on our instructions**, only for the purposes below, and never for their own:",
		"- **Cloudflare** — your IP address, browser user-agent and request headers, for every request, plus **everything you upload**: your files, images, video and audio are stored on Cloudflare R2. DNS, DDoS protection, and filtering automated traffic. Every request to Anthers passes through Cloudflare before it reaches us.\n- **DigitalOcean** — application hosting and the database.\n- **Stripe** — card details, payment and payout records, and (on our payment pages only) device and browser information for fraud prevention.\n- **Resend** — your email address and the contents of the email we send you.",
		"**Checking uploads against known child sexual abuse material sends a fingerprint, never your file.** We calculate a **perceptual hash** — a short mathematical fingerprint, not the picture — and send only that to the **Canadian Centre for Child Protection**, which tells us whether it matches known material. Images are checked directly; a video is sampled into still frames and each frame is checked the same way. **Your files themselves never leave Anthers for this, and neither does anything that would let the Centre fetch them.** A fingerprint that does not match, which is nearly all of them, tells them nothing whatsoever about you or what you uploaded. **Audio is not covered**, because the fingerprint describes a picture and there is nothing in a sound for it to describe.",
		"**The Centre is not one of our service providers, and that difference is worth stating rather than burying.** Everyone in the list above works on our instructions and for our purposes. The Centre is an independent organization pursuing its own child-protection purpose, and under our agreement each of us decides independently what to do with what we hold — so it does not belong in that list, and adding it there would make the sentence above it untrue. What it receives from us is the fingerprint and nothing else.",
		"**One disclosure goes to another person rather than to a provider, and the law requires it.** If your work is removed after a copyright notice and you file a counter-notice, **we forward your legal name, postal address and telephone number to the person who filed the notice**, along with your consent to federal jurisdiction. We cannot run the process without doing that — it is what a counter-notice is under the law, and a provider who withheld it would not be forwarding a counter-notice at all. The reverse holds in a smaller way: when we act on a notice, the creator is told **who filed it**, because being accused without being told by whom is not a process anyone can answer. This is the one place on Anthers where using a feature discloses your home address to another user, and our [copyright page](/copyright) says so before the form rather than beside the submit button.",
		"We may also disclose information **where we are legally compelled to** — a valid court order, subpoena, or equivalent legal process. We check that the demand is genuine and that it reaches what it claims to reach, and we produce the least it compels rather than the most it asks for. **Where we are permitted to tell you, we will, and we tell you before we produce anything**, so that you have the chance to object on your own behalf. Where a court forbids us to tell you, that prohibition has an end date; we record it, and we tell you when it lapses.",
		"We publish **aggregate, anonymized** figures — totals, trends, charitable transparency reporting — which cannot be traced to any individual.",
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
		"**Sign-in codes:** a code stops working after ten minutes. The record is deleted the moment it is used, and otherwise by a daily sweep — so an unused one is dead long before it is gone. Nothing else is kept: if you never finish, no account is created.",
		"**Payment records:** kept as long as tax, accounting, and nonprofit reporting law requires, which is longer than your account may exist and is not a period we can choose.",
		"**Safety and copyright records** — reports, copyright notices, and the decisions we made about them — work differently from everything above, and the difference is worth stating plainly rather than burying in a number. **The record is permanent. The personal detail in it is not.**",
		"- **We keep the record itself indefinitely** — that a report was made, what it claimed, what we decided, and what happened to the work. It outlives the content and both accounts. If a decision could simply be erased, *“why was my comment removed?”* would have no honest answer and an appeal would be impossible. For copyright there is a second reason: the law requires us to have a policy for ending the accounts of repeat infringers, and **a record the accused person can erase — by deleting the work — is not a record.**\n- **After three years we delete the personal details from it.** For a copyright notice that is the sender's name, postal address, telephone number and email, and — if the creator answered — the same four things about them. For a report it is the reporter's own words and the link to who they were. Everything else stays.\n- **Three years, counted from the last thing that happened to the record**, not from when it arrived — so letting something sit does not run the clock down.\n- **Why three:** it is how long somebody could still bring a copyright claim, or a claim that a notice was filed dishonestly, in either direction. The details survive exactly as long as somebody could still need them in court, and no longer.\n- **A live court case stops the clock.** If either side has gone to court over a notice, nothing about it is deleted while that is true.",
		"Two things this deliberately does not cover, said so that their absence is a decision rather than a gap. **Our own record of the decision** — the operator, the date, the reason, our internal note — is never redacted: it holds nobody else's contact details and it is the thing that answers the appeal. And **IP addresses** are not part of this at all; the only ones we hold sit on sign-in sessions and go when the session expires, as above.",
		"**What we publish about all of this is counts, not notices.** Totals — how many notices we received, acted on, rejected, how many were answered, how many works came back — are on the [copyright page](/copyright). We do not publish the notices themselves: publishing one would publish the sender's home address and identify the creator it named, and doing that by default is a decision about other people's privacy we are not willing to make on their behalf.",

		"## Your rights",
		"These rights are extended to everyone who uses Anthers, wherever you live.",
		"- **Know** what we hold about you and why — this document, and on request the specifics.\n- **Get a copy** of your information and your content, in an openly readable format. It's in your settings, and it's immediate.\n- **Correct** anything inaccurate — most of it directly in your settings.\n- **Delete** your account and content — see below.\n- **Object** to a particular use, and ask us to stop.\n- **Complain** to your data protection authority, if you are somewhere that has one.",
		"We will not charge you for exercising these, and we will not treat you differently for it.",
		"Two of them are buttons rather than requests: **downloading your data** and **deleting your account** both happen in [your settings](/settings), without asking us. For anything else, ask us and we will respond **within 30 days**.",

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
		"**Content made for young audiences is free, and funded by us**, never advertising and never engagement-optimized. There is no advertising anywhere on Anthers and no mechanism anywhere that profits from anyone's attention, at any age.",
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
		"These are the terms for using Anthers as a person — reading, watching, playing, commenting, supporting creators, and buying things. If you publish work here, the [Creator Terms](/creator-terms) apply on top of these.",
		"We've tried to write these so you can actually read them. Where something is a genuine legal requirement we've said so plainly rather than burying it.",

		"## Who can use Anthers",
		"**You have to be 13 or older.** We don't ask your age and we don't verify it — see the [Privacy Policy](/privacy) for why — so this is a rule you're agreeing to keep rather than one we check.",
		"You're responsible for what happens under your account, and for keeping your password to yourself.",

		"## What you can expect from us",
		"Anthers is a nonprofit. **We take no cut of what you give creators** — the only deduction on monthly support or a purchase is the card processing that the payment network charges, which goes to the processor and not to us.",
		"We'll keep the platform running as well as we reasonably can, and we'll tell you before we make a change that materially affects your rights.",
		"**We won't sell your data, show you advertising, or optimize anything here to consume more of your attention.**",

		"## What we expect from you",
		"Don't post things that are illegal, that harass or threaten people, that sexualise minors in any way, or that you don't have the right to post. Don't try to break, overload, or get around the access controls on other people's work.",
		"If you break these, we may hide the content, or in serious cases end your account. We keep a record of what we did and why, so that if you ask, you get an honest answer.",

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
		"There are narrow cases where a creator can have work taken down immediately — a lost license, a legal order, a safety reason — and in those cases you're refunded.",
		"**A copyright takedown is the other exception, and the only case where somebody outside the sale can end it.** If a copyright owner files a valid notice against a work you bought, we have to remove it — and unlike ordinary removal, that means removing it from your library too, not just from public view. Continuing to deliver work we've been told infringes would be continuing to infringe, so it isn't a promise we're able to keep. **We refund you in full**, and it never counts against your refund limit — it wasn't your decision.",
		"The refund comes when the removal is **final**, not the moment it happens: the creator has ten business days to answer the notice, and a work that comes back was never a sale that should have been undone. If they do answer and it's restored, it goes back on sale rather than back into your library — your money has already come back to you. The whole process is on our [copyright page](/copyright).",

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
		"**Anthers takes no cut.** On a direct purchase you receive the price you set, less the card processing the payment network charges — the only deduction there is. Delivery costs nothing, however large the work or however many times the buyer downloads it. On monthly support given to you directly, you receive the full amount less its share of card processing.",
		"You are also paid from the pool funded by what people give Anthers, in proportion to time they spend with your work. A minute is a minute regardless of whether it's a game, a video, audio, or writing.",
		"Payouts run through Stripe on their schedule. Tax is yours to handle; we report what we're required to report.",

		"## Storage",
		"Your first 50 GiB of storage is free. Above that you're charged what it costs us plus half again, and that surcharge funds free access for people who can't pay.",

		"## If you remove work someone bought",
		"**People who paid for something keep it.** If you delete a Work that has buyers, it's withdrawn rather than destroyed — it leaves public circulation and stays in their library. We email them so they can download a copy.",
		"If you need something gone *immediately* — a lost license, a safety reason, a legal order — that's a takedown request, handled quickly and separately, and buyers are refunded.",
		"If you close your account, the same applies to everything you've sold.",

		"## When somebody else asks for your work to come down",
		"The takedown above is the one **you** ask for. This is the other one, and it's worth reading before it happens rather than after.",
		"If a copyright owner files a valid notice against something you published, we remove it. A person reviews every notice and nothing is automated — but the law asks us to act *promptly*, so **the removal comes first and the argument comes after.** We don't hold a notice for a day to hear from you first, because that's the one design that would cost us the legal protection this whole process exists to keep.",
		"- **The work stops being delivered to everyone, including the people who bought it**, and those buyers are refunded. Continuing to serve it would be continuing to infringe.\n- **We tell you straight away**, with the reason, who filed it, and how to answer.\n- **One notice takes down the work it named.** Never your catalog, never your account, never everything you've published. We consider this the single most important limit on the process — a takedown that could sweep a catalog is a competitor-removal tool.\n- **You can file a counter-notice**, and if you do, the work goes back up in ten to fourteen business days unless the person who filed takes you to court.",
		"**Read this before you counter-notice, because it's the part nobody tells you.** A counter-notice requires your **legal name, postal address and telephone number**, and your **consent to be sued in federal court** where you live — and **those details are forwarded to the person who filed the notice.** If you publish under a name that isn't your own, a counter-notice isn't simply a remedy: it hands your accuser your identity and your address. It may still be the right choice. It should be an informed one.",
		"**If you agree the notice was right, you can say so** and settle it — your buyers are refunded straight away rather than waiting out a clock whose answer both sides already know. Conceding costs you nothing you hadn't already lost, and waives nothing.",
		"**If you don't answer within ten business days**, we treat the removal as final and refund the buyers. You can still file a counter-notice after that and we'll still restore the work — the deadline governs when the money is settled, never whether you're allowed to answer.",
		"**Repeatedly infringing copyright can end your account.** That's in the [Terms of Service](/terms), along with the two things that matter most about how we run it: a person decides every time, and we publish no strike number. Everything here, including our designated agent's details, is on the [copyright page](/copyright).",

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
