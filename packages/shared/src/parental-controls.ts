// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parental controls — the policy half, pure and with no I/O, the same split as
 * `public-access.ts` and `resolveAccessSync`.
 *
 * 🚨 **A guardian's controls sit on the VIEWER, never on the Work**, and every rule here
 * follows from that. Nothing a guardian sets changes what a Work *is*: a blocked creator is
 * not less rated, a Work past a daily limit is not less free, and a censored word was never
 * part of any classification. What changes is what reaches one account. Encoding any of it as
 * a property of the content would stratify the commons in exactly the way retiring Anthers
 * Gates was for — and it would leak one household's settings into everybody's catalog.
 *
 * **Four of the five controls are one shape.** A creator rule and a media-type rule are the
 * same rule with a different key; a whole-app limit is the same limit with no key at all. So
 * this module has one rule type and one verdict, rather than three parallel systems that
 * would drift the first time somebody added a fourth dimension.
 *
 * ⚠️ **The fifth — language filtering — is deliberately the odd one out and cannot be made to
 * fit.** Strong language never affects a Work's rating (the wiki's *Rating Standard*), so the filter runs over
 * content **nobody classified**: it cannot read a rating or a content note to decide where to
 * apply, and it therefore behaves differently from every other control here. It is a courtesy
 * for a household, not a guarantee about anything, and the word list says so.
 */

/**
 * One rule in a list — a creator, or a media type.
 *
 * `allow` is the verdict for this key and `dailySeconds` is a cap that applies *when the
 * verdict is allow*, so "an hour of games a day" is one entry rather than a second mechanism.
 * A blocked key ignores the cap, because a cap on something unreachable says nothing.
 */
export interface ParentalRule {
	/** A creator id as a string, or a Work type (`video`, `text`, `game`, …). */
	key: string;
	allow: boolean;
	/** Seconds per day this key may be consumed for, or null for uncapped. */
	dailySeconds: number | null;
}

/**
 * A list of rules plus what happens to everything not in it.
 *
 * 🚨 **One shape covers both an allowlist and a blocklist**, which is what keeps a guardian
 * from having to understand a mode. `defaultAllow: false` with `allow: true` entries is
 * "only these"; `defaultAllow: true` with `allow: false` entries is "everything but these".
 * A separate `mode` field would be a second source of truth able to disagree with the rules
 * it governs — the same reason the access table has no mode either.
 */
export interface ParentalList {
	defaultAllow: boolean;
	rules: ParentalRule[];
}

/** Whole-app consumption caps. Null is uncapped; all three may apply at once. */
export interface ParentalLimits {
	daily: number | null;
	weekly: number | null;
	monthly: number | null;
}

export interface ParentalPolicy {
	/** Whether a pin has been set at all. Nothing below applies without one. */
	enabled: boolean;
	/**
	 * Whether the content-rating settings are locked — the per-rung display preferences, and
	 * the Adult opt-in that decides whether the account reaches the rung at all.
	 *
	 * 🚨 **Two switches, not one, and they are worth locking independently.** The scale runs
	 * `general · mature · adult`, and a reader who wants difficult work unblurred has said
	 * nothing about whether they want explicit work at all — so a guardian may reasonably
	 * unblur Mature for a sixteen-year-old while leaving Adult off. The lock covers the six
	 * content notes for the same reason: allowing intense horror and blurring substance use is
	 * a real position.
	 *
	 * 🚨 **The opt-in is what makes this a child-safety control rather than a display one, and
	 * it was outside the lock until 2026-08-29.** Reaching Adult work needs adulthood verified
	 * by card funding type, and a parent's credit card passes that check honestly — so the
	 * borrowed card is the scenario the pin exists for, and the only thing that can refuse it
	 * is the account. `services/content-preferences.ts` asks `maturityLocked` before every
	 * write it makes, so both routes that open the rung are covered along with the display
	 * settings; opting back *out* is left alone, since that only tightens.
	 */
	lockMaturity: boolean;
	creators: ParentalList;
	types: ParentalList;
	limits: ParentalLimits;
	/** "Good Place" word replacement over displayed text. See `censorText`. */
	languageFilter: boolean;
}

/** No controls at all — what every account has until a guardian sets a pin. */
export const NO_PARENTAL_CONTROLS: ParentalPolicy = {
	enabled: false,
	lockMaturity: false,
	creators: { defaultAllow: true, rules: [] },
	types: { defaultAllow: true, rules: [] },
	limits: { daily: null, weekly: null, monthly: null },
	languageFilter: false,
};

/** Why a Work is out of reach for this account, or null when it is not. */
export type ParentalRefusal = "blocked_creator" | "blocked_type";

/** The rule for a key, or null when the list says nothing about it. */
function ruleFor(list: ParentalList, key: string | null): ParentalRule | null {
	if (key == null) return null;
	return list.rules.find((r) => r.key === key) ?? null;
}

/** Whether a list permits a key, falling back to its default. */
function permits(list: ParentalList, key: string | null): boolean {
	const rule = ruleFor(list, key);
	if (rule) return rule.allow;
	// An absent key with `defaultAllow: false` is refused — which is what makes an allowlist
	// an allowlist. A null key (a Work whose creator deleted their account) takes the default
	// too, rather than being quietly exempted from a list it cannot be named in.
	return list.defaultAllow;
}

/**
 * May this account reach a Work by this creator, of this type?
 *
 * 🚨 **Creator first, then type, and the order is reported rather than merely applied.** A
 * guardian who has allowed three creators and blocked games needs to know which rule stopped
 * something, or the panel becomes a thing you fight instead of a thing you configure.
 */
export function parentalRefusal(
	policy: ParentalPolicy,
	subject: { creatorId: number | null; workType: string | null },
): ParentalRefusal | null {
	if (!policy.enabled) return null;
	if (!permits(policy.creators, subject.creatorId == null ? null : String(subject.creatorId))) {
		return "blocked_creator";
	}
	if (!permits(policy.types, subject.workType)) return "blocked_type";
	return null;
}

/**
 * The tightest daily cap that applies to a Work, in seconds, or null.
 *
 * ⚠️ **The whole-app daily limit participates**, so "two hours a day, of which one may be
 * games" needs no special case: both caps are candidates and the smaller wins. A guardian
 * setting a per-type cap above the whole-app one has simply not tightened anything, which is
 * the honest outcome rather than an error to explain.
 */
export function dailyCapFor(
	policy: ParentalPolicy,
	subject: { creatorId: number | null; workType: string | null },
): number | null {
	if (!policy.enabled) return null;
	const candidates = [
		policy.limits.daily,
		ruleFor(policy.creators, subject.creatorId == null ? null : String(subject.creatorId))
			?.dailySeconds ?? null,
		ruleFor(policy.types, subject.workType)?.dailySeconds ?? null,
	].filter((n): n is number => n != null && n >= 0);
	return candidates.length === 0 ? null : Math.min(...candidates);
}

/**
 * The media a guardian can allow or block, with the words a panel shows.
 *
 * 🚨 **A medium missing from here cannot be blocked, and nothing would say so.** That is the
 * same trap `CONSUMPTION` in `attention.ts` documents — an unregistered type is silently
 * inert — so the two lists are pinned against each other in `parental-controls.test.ts`. A new
 * medium that nobody adds here is one a guardian has no way to exclude, which is a worse
 * failure than an unfamiliar label.
 *
 * ⚠️ **`physical` and `service` are deliberately absent.** Both carry consumption mode `none` —
 * a shipped object and a commissioned piece of work are consumed off the platform entirely —
 * so there is no reaching for a guardian to restrict and no seconds to cap. Blocking one would
 * be blocking a *purchase*, which is a different thing this panel does not claim to do.
 */
export const PARENTAL_MEDIA_TYPES: readonly { value: string; label: string }[] = [
	{ value: "video", label: "Video" },
	{ value: "audio", label: "Audio" },
	{ value: "text", label: "Writing" },
	{ value: "ebook", label: "Books & comics" },
	{ value: "image", label: "Images" },
	{ value: "game", label: "Games" },
	{ value: "software", label: "Software" },
];

/** Which window a limit was hit in, for copy that can say what happens next. */
export type LimitWindow = "day" | "week" | "month";

/** How much of each window this account has already consumed. */
export interface ConsumedSeconds {
	day: number;
	week: number;
	month: number;
	/** Seconds consumed today against the specific creator or type in question. */
	scopedDay: number;
}

/**
 * The window whose limit is spent, or null when there is time left in all of them.
 *
 * Returns the **narrowest** spent window, because that is the one whose reset is soonest and
 * therefore the one worth telling somebody about: "you have more tomorrow" is useful where
 * "you have more next month" is not, and reporting the monthly cap when the daily one is what
 * actually bit would be true and useless.
 */
export function spentWindow(
	policy: ParentalPolicy,
	consumed: ConsumedSeconds,
	scopedCap: number | null,
): LimitWindow | null {
	if (!policy.enabled) return null;
	// The scoped cap is a *daily* cap by construction, so it reports as the day window.
	if (scopedCap != null && consumed.scopedDay >= scopedCap) return "day";
	if (policy.limits.daily != null && consumed.day >= policy.limits.daily) return "day";
	if (policy.limits.weekly != null && consumed.week >= policy.limits.weekly) return "week";
	if (policy.limits.monthly != null && consumed.month >= policy.limits.monthly) return "month";
	return null;
}

// ── Language ─────────────────────────────────────────────────────────────────

/**
 * The substitutions, in the spirit of *The Good Place*.
 *
 * 🚨 **Exact words, deliberately, rather than a stem with a suffix rule.** "fucking" →
 * "forking" works beautifully and "shitty" → "shirtty" does not, so every inflection worth
 * covering is listed and anything unlisted is left alone. A predictable filter that misses a
 * word is better than a clever one that mangles a sentence, and the whole thing is a courtesy
 * to a household rather than a claim about content.
 *
 * ⚠️ **This is not a safety feature and must never be described as one.** Strong language does
 * not affect a Work's rating at all (the wiki's *Rating Standard*), so the filter runs over content nobody
 * classified: it has no rating and no content note to consult, cannot know what it has not
 * been told about, and will miss things. What it does is stop a household being surprised by
 * a word — which is worth doing and worth being honest about.
 */
export const LANGUAGE_SUBSTITUTIONS: Readonly<Record<string, string>> = {
	fuck: "fork",
	fucks: "forks",
	fucked: "forked",
	fucking: "forking",
	fucker: "forker",
	fuckers: "forkers",
	motherfucker: "motherforker",
	motherfuckers: "motherforkers",
	shit: "shirt",
	shits: "shirts",
	shitty: "shirty",
	shitting: "shirting",
	bullshit: "bullshirt",
	bitch: "bench",
	bitches: "benches",
	ass: "ash",
	asshole: "ashhole",
	assholes: "ashholes",
	damn: "darn",
	damned: "darned",
	dick: "dink",
	dicks: "dinks",
	piss: "miss",
	pissed: "missed",
	cunt: "cart",
	cunts: "carts",
	bastard: "bastion",
	bastards: "bastions",
};

/** Match any listed word on its own, longest first so "motherfucker" beats "fucker". */
const CENSOR_PATTERN = new RegExp(
	`\\b(${Object.keys(LANGUAGE_SUBSTITUTIONS)
		.sort((a, b) => b.length - a.length)
		.join("|")})\\b`,
	"gi",
);

/** Re-dress a replacement in the case the original was wearing. */
function matchCase(original: string, replacement: string): string {
	if (original === original.toUpperCase()) return replacement.toUpperCase();
	if (original[0] === original[0]?.toUpperCase()) {
		return replacement[0]!.toUpperCase() + replacement.slice(1);
	}
	return replacement;
}

/**
 * Substitute the listed words in a run of plain text, preserving case.
 *
 * 🚨 **Plain text only — never pass HTML through this.** A tag name, an attribute or a URL can
 * contain a listed word, and rewriting one would change what a link points at or break the
 * markup outright. The browser-side `censorHtml` walks text nodes and calls this on each; that
 * separation is the whole reason this function is narrow.
 */
export function censorText(input: string): string {
	if (!input) return input;
	return input.replace(CENSOR_PATTERN, (word) => {
		const replacement = LANGUAGE_SUBSTITUTIONS[word.toLowerCase()];
		return replacement ? matchCase(word, replacement) : word;
	});
}
