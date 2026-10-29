import type {
	workAssets,
	workBuildFiles,
	workBuilds,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
import {
	CHARGEABLE_AMOUNT_MESSAGE,
	isChargeableAmount,
	SAVE_BLOB_MAX_CHARS,
} from "@anthers/shared/constants";
import {
	COMMENT_MAX,
	embedUrlProblem,
	isReviewVerdict,
	REVIEW_MAX,
	WORK_TYPES,
} from "@anthers/shared/content";
import { RATING_APPEAL_STATEMENT_MAX } from "@anthers/shared/content-rating";
import { imageCropSchema } from "@anthers/shared/image-frame";
import { PROJECT_SORT_DIRECTIONS, PROJECT_SORT_MODES } from "@anthers/shared/project-sort";
import { normalizeWorkTags, workTagsProblem } from "@anthers/shared/tags";
import { isVoteDirection } from "@anthers/shared/votes";
import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { invalidBody } from "../../middleware/validate.js";
import type { GrantRefusal } from "../../services/access-grants.js";
import { POST_BODY_LIMIT } from "../../services/post-markdown.js";

export const saveBlobSchema = z.object({
	blob: z.string().min(1).max(SAVE_BLOB_MAX_CHARS),
	runtime: z.string().max(40).optional().default(""),
	note: z.string().max(2000).optional().default(""),
});

/**
 * A reading position's pointer — the type-specific half of a position, opaque to the
 * server: `{ page, panel }` for a paged Work, `{ cfi }` for a reflow one, `{}` for a text
 * Work. Only the client's readers assign the keys meaning; here it is bounded by entry
 * count and serialized size so a bloated payload cannot ride a shape nobody interprets.
 */
export const positionPointerSchema = z
	.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
	.refine((p) => Object.keys(p).length <= 8 && JSON.stringify(p).length <= 2048, {
		message: "That position is over the size limit.",
	});

/** An image Work is its own thumbnail and takes no other (`isOwnThumbnail`). */
export const IMAGE_THUMBNAIL_REFUSAL = {
	error: "An image is its own thumbnail, so it can't be given another.",
	code: "image_is_its_thumbnail",
} as const;

export const MONEY = /^\d+(\.\d{1,2})?$/;

/**
 * One row shape for the Work's one access table: a monthly-dollar threshold, an allow
 * flag, and a price. The threshold is what the user has given this Work's creator
 * this cycle, and there is exactly one such table.
 *
 * `badgeId` names the creator's rung the gate sits on; it is absent on the Everyone
 * baseline, and `normalizeAccessRows` (services/access.ts) is what checks it against the
 * creator's ladder and stamps the threshold from the rung. The number a client sends with
 * a badgeId is therefore advisory — the rung's current amount wins.
 *
 * 🚨 **Cents, not integers, and this is a justification that inverted under its own
 * premise.** Refusing a fractional threshold was once right — a gate nobody could exactly
 * meet is a gate nobody can clear — and became exactly backwards when amounts stopped
 * being whole multiples of anything: $2.50 is an ordinary thing to give, so refusing it
 * writes off the amounts a creator is most likely to choose. **Check whether a rule's
 * reason still holds before preserving the rule.**
 *
 * Two cents of precision, because that is what can be charged and what `amountMeets`
 * compares in. Finer would be a threshold nobody could pay to the cent.
 */
export const accessRowSchema = z.object({
	threshold: z
		.number()
		.nonnegative()
		.refine(
			(v) =>
				Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
			{
				message: "Threshold must be a whole number of cents",
			},
		)
		// 🚨 A threshold is a level of monthly support a user must be giving, and a level
		// nobody can fund is a rung nobody can climb — `directed[].amount` refuses anything
		// between zero and Stripe's minimum, so a $0.25 gate is unreachable by construction.
		// The baseline row sits at 0 and must stay legal, which is why this is the "$0 or at
		// least the floor" predicate rather than a minimum.
		.refine(isChargeableAmount, { message: CHARGEABLE_AMOUNT_MESSAGE }),
	// The rung the gate sits on. Nullable rather than optional so a client clearing a gate
	// says so; whatever is not the Everyone baseline must name one of the creator's own
	// rungs, which the handler checks.
	badgeId: z.number().int().positive().nullable().optional(),
	allow: z.boolean(),
	// 🚨 **The floor sits on the PRICE, never on the buyer's total.** Sales tax is added on
	// top of the price at the charge, so flooring the total would make a $0.47 Work
	// purchasable in a taxed jurisdiction and not in an untaxed one — and the tax rate is
	// resolved by Stripe Tax per buyer location rather than being one flat figure, so the
	// boundary would move with wherever the buyer happened to be.
	price: z
		.string()
		.regex(MONEY)
		.refine((v) => isChargeableAmount(Number(v)), { message: CHARGEABLE_AMOUNT_MESSAGE }),
});

/**
 * One credit row — creator-asserted provenance (`WorkCredit` in the schema).
 *
 * Two rules are enforced rather than trusted. A credit must assert SOMETHING — an empty
 * `types` is not a credit — and a `created` assertion must name its human or entity: anything
 * a person made, alone or blended with a machine, says who made it. A pure `generated` row
 * may stay anonymous; a generated credit never names a model, because a model owns nothing
 * and is granted nothing.
 */
export const workCreditRowSchema = z.object({
	role: z.string().max(255),
	contributor: z.string().max(255).default(""),
	types: z.array(z.enum(["created", "generated"])).min(1),
});

/** Every credit asserting `created` names its contributor. */
export const workCreditsSchema = z
	.array(workCreditRowSchema)
	.superRefine((rows, ctx) => {
		rows.forEach((row, i) => {
			if (row.types.includes("created") && row.contributor.trim() === "") {
				ctx.addIssue({
					code: "custom",
					path: [i, "contributor"],
					message: "A created credit names its contributor.",
				});
			}
		});
	})
	.optional();

// ── Works (the Catalog) ──

/** When the work first came out ANYWHERE, creator-asserted, optional. */
export const originallyReleasedSchema = z.object({
	originallyReleased: z.string().datetime().nullable().optional(),
});

/**
 * A Work's tag list, normalized and refused in the creator's own words.
 *
 * 🚨 **The cap is enforced here rather than only in the Details tab**, because the API is
 * the authority and a second client must meet the same five. Normalization runs before
 * the check so `["Indie", "indie"]` is one tag rather than two against the cap.
 */
export const workTagsSchema = z
	.array(z.string())
	.transform((tags) => normalizeWorkTags(tags))
	.superRefine((tags, ctx) => {
		const problem = workTagsProblem(tags);
		if (problem) ctx.addIssue({ code: "custom", message: problem });
	});

export const workBaseSchema = z
	.object({
		title: z.string().max(255).optional().default(""),
		slug: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers, hyphens")
			.optional(),
		description: z.string().max(50000).optional().default(""),
		thumbnail: z.string().max(500).optional().default(""),
		/**
		 * The full upload the thumbnail is framed from. Stored beside it so a reposition can
		 * zoom back out; kept out of every public serializer, because it is the uncropped file.
		 */
		thumbnailSource: z.string().max(500).optional().default(""),
		/** The window the thumbnail was framed at, so a reposition reopens where it was left. */
		thumbnailCrop: imageCropSchema.nullable().optional(),
		sourceKey: z.string().max(500).optional().default(""),
		embedUrl: z
			.string()
			.superRefine((value, ctx) => {
				const problem = embedUrlProblem(value);
				if (problem) ctx.addIssue({ code: "custom", message: problem });
			})
			.optional()
			.default(""),
		durationSeconds: z.number().int().optional(),
		// type = "text": the prose itself.
		body: z.string().optional().default(""),
		bodyHtml: z.string().optional().default(""),
		// type = "music": the song's words, plain text and untimestamped. Bounded generously
		// — a long song with repeats runs to a few thousand characters, and an epic runs to
		// more. No sanitizer, because nothing here is ever rendered as HTML.
		lyrics: z.string().max(20_000).optional(),
		// type = "image": the alt text of the image the Work is, rendered as the img's alt
		// beside the image itself. No sanitizer either — an img attribute, never markup.
		imageAlt: z.string().max(1000).optional(),
		// The fulfillment details a physical good or a service carries, in the creator's
		// own words. Creator-only; the public serializer never sends it.
		note: z.string().max(2000).optional().default(""),
		/**
		 * The name of the CURRENT media version, empty to leave it unnamed. A reader sees it
		 * beside the version's date once the version was added after the Work was released;
		 * the archived row carries it into history when a replacement takes over.
		 */
		versionLabel: z.string().max(80).optional(),

		// Visibility. `released` is public listing, NOT public access — the gates decide that.
		visibility: z.enum(["private", "released"]).optional(),
		// When a private Work is to be released; null clears it. Refused on create, like a
		// release, and checked on a change by the edit route.
		scheduledReleaseAt: z.string().datetime().nullable().optional(),

		// The content rating, as the matrix a creator answers row by row (`RATING_ROWS`). A
		// complete one decides the rating and the notes; an incomplete one is only stored. Rows
		// and levels this build does not know are dropped rather than refused.
		// `services/content-rating.ts` decides whether the change is allowed — an operator's
		// correction can only be raised, not lowered, by the creator.
		maturityRows: z.record(z.string(), z.enum(["none", "general", "mature", "adult"])).optional(),
		// 🚨 Accepted only so a request naming a rating can be REFUSED rather than silently
		// stripped: a creator rates a Work by answering every row, never by naming a rung
		// (Parker, 2026-09-18). See `namesARating` below.
		maturity: z.string().optional(),
		maturityNotes: z.array(z.string()).max(20).optional(),

		// Delivery (≥1 enforced on release)
		streamEnabled: z.boolean().optional(),
		downloadEnabled: z.boolean().optional(),

		// Access table (default "free but fully locked" applied server-side when omitted)
		access: z.array(accessRowSchema).optional(),

		// Credits — the work's liner notes (see workCreditsSchema for the rules).
		credits: workCreditsSchema,

		// Presentation & metadata
		isPinned: z.boolean().optional(),
		tags: workTagsSchema.optional(),
		websiteUrl: z.string().max(500).optional(),
		sourceUrl: z.string().max(500).optional(),
	})
	.merge(originallyReleasedSchema);

/**
 * A creator's appeal against an operator's rating correction.
 *
 * The statement is required and has a floor, because an appeal is an argument: a queue of
 * empty appeals is a queue an operator learns to clear without reading, which costs the
 * creators with something to say.
 */
export const ratingAppealSchema = z.object({
	requestedMaturity: z.enum(["general", "mature", "adult"]),
	statement: z.string().trim().min(10).max(RATING_APPEAL_STATEMENT_MAX),
});

export const createWorkSchema = workBaseSchema.extend({ type: z.enum(WORK_TYPES) });

export const updateWorkSchema = workBaseSchema
	.partial()
	// The kind may change while the Work is a draft with nothing kind-specific in it yet —
	// see the type-change block in the PATCH handler for the exact rule and its refusals.
	.extend({ type: z.enum(WORK_TYPES).optional() });

/**
 * The two Work bodies, validated so that a refused field answers with a sentence a creator can read
 * rather than a serialized `ZodError`, which reaches a form as "[object Object]". The embed address
 * is the refusal that made this matter; see `invalidBody`.
 */
/** The one file a grant is asked for: delivery is scoped to the asset being served. */
export const grantBody = zValidator(
	"json",
	z.object({ assetId: z.number().int().positive() }),
	invalidBody,
);

/**
 * The answer a client can act on when a grant is missing or wrong.
 *
 * Every refusal is a 403 with a `code` the downloader branches on: `grant_expired` means ask
 * for another, `grant_required` means the client is old enough to be missing the flow, and
 * the rest mean the token does not belong to this request.
 */
export function grantRefusal(reason: GrantRefusal): { error: string; code: string } {
	const messages: Record<GrantRefusal, string> = {
		issuer_unavailable: "Downloads are not available right now.",
		malformed: "A download grant is required.",
		wrong_type: "That is not a download grant.",
		bad_signature: "That download grant is not valid.",
		expired: "Your download grant has expired. Try again.",
		wrong_work: "That download grant is for another Work.",
		wrong_reader: "That download grant is for another account.",
		wrong_file: "That download grant is for another file.",
	};
	return { error: messages[reason], code: `grant_${reason}` };
}

export const createWorkBody = zValidator("json", createWorkSchema, invalidBody);
export const updateWorkBody = zValidator("json", updateWorkSchema, invalidBody);

/** One file joining a paged Work's set — the set routes stay thin, so this is the whole of it. */
export const sourceFileSchema = z.object({
	// A storage key or URL, as the upload step hands it back. Bounded like every storage ref.
	file: z.string().min(1).max(500),
	filename: z.string().max(255).optional(),
	fileSize: z.number().int().nonnegative().nullable().optional(),
	mimeType: z.string().max(100).optional(),
});

/**
 * A set append: one file, or a whole pick.
 *
 * 🚨 **The array is the shape the set editors send** (2026-10-19). A comic's ordinary path is
 * a hundred page images in one pick, and appending them one file per request enqueued one
 * render per file — each rendering the whole set (see `services/work-source-files.ts`). The
 * single object stays accepted because it is the same mutation with a pick of one, and the
 * desktop and an older web bundle must keep working.
 *
 * The cap matches the renderer's own page ceiling (`MAX_PAGES` in `jobs/render-paged.ts`):
 * a pick larger than that could never render, so it is refused before a byte of it is stored
 * as a source row.
 */
export const MAX_SOURCE_PICK = 2000;
export const sourceFilesSchema = z.union([
	sourceFileSchema,
	z.object({ files: z.array(sourceFileSchema).min(1).max(MAX_SOURCE_PICK) }),
]);

/** A whole-set arrangement: the ids in the order the creator is showing. No partial orders. */
export const sourceOrderSchema = z.object({ order: z.array(z.number().int()) });

/**
 * A physical listing as a client sends it.
 *
 * Loose on purpose at this layer: the shape is validated once in
 * `services/physical-listings.ts`, which is the module a quote, a checkout and an order
 * all read, and a second stricter copy here would be the copy that drifts. What this
 * guarantees is only that the body carries the listing's fields and not something else.
 */
export const physicalListingSchema = z.object({
	shippingPrice: z.union([z.string(), z.number()]).optional(),
	handlingBusinessDays: z.union([z.string(), z.number()]).optional(),
	taxCategory: z.string().optional(),
	options: z
		.array(
			z.object({
				name: z.string(),
				values: z.array(
					z.object({
						label: z.string(),
						stock: z.union([z.number(), z.string(), z.null()]).optional(),
					}),
				),
			}),
		)
		.optional(),
	images: z
		.array(
			z.object({
				key: z.string().min(1).max(500),
				alt: z.string().max(300).default(""),
			}),
		)
		.optional(),
});

/** One caption track to attach: the uploaded .vtt's key, its language tag, and its menu label. */
export const captionAttachSchema = z.object({
	key: z.string().min(1).max(500),
	// A BCP-47 tag as broad as `zh-Hant-TW` fits; the shape gate itself is in the service.
	language: z.string().min(2).max(35),
	label: z.string().max(100).default(""),
	kind: z.enum(["captions", "subtitles"]).default("captions"),
});

/** One storefront preview item to attach: what it is and the uploaded file's key. */
export const previewAttachSchema = z.object({
	kind: z.enum(["image", "video"]),
	key: z.string().min(1).max(500),
	alt: z.string().max(500).default(""),
});

/** An image's alt text — the trailer counterpart carries none. */
export const previewUpdateSchema = z.object({ alt: z.string().max(500) });

/** A whole-set arrangement: the ids in the order the creator is showing. No partial orders. */
export const previewOrderSchema = z.object({ previewIds: z.array(z.number().int()) });

export const postBaseSchema = z.object({
	title: z.string().max(255).optional().default(""),
	slug: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers, hyphens")
		.optional(),
	// The post's content, as **markdown — the stored, canonical form**. A client may send it
	// directly; whatever arrives goes through `normalizeStoredMarkdown`, so a `body` is bound
	// by exactly what the HTML allowlist permits. Search reads this column directly: LIKE
	// over markdown source matches the same words a plain-text shadow would, so no shadow.
	body: z.string().max(POST_BODY_LIMIT).optional().default(""),
	// The editor's HTML, converted to markdown server-side and never stored. Kept on the
	// wire because TipTap lives in the client; a client that has moved to markdown simply
	// stops sending it.
	bodyHtml: z.string().optional().default(""),

	// Presentation
	isPinned: z.boolean().optional().default(false),

	// Metadata
	tags: z.array(z.string()).optional().default([]),
	isPublished: z.boolean().optional().default(false),
	// ISO datetime at which a still-unpublished draft should auto-publish; null clears the
	// schedule. Publishing now (isPublished=true) supersedes and clears any schedule.
	scheduledFor: z.string().datetime().nullable().optional(),

	// Optionally attach to a Project on create.
	projectId: z.number().int().optional(),
});

export const createPostSchema = postBaseSchema;

export const updatePostSchema = postBaseSchema.partial();

/** Query flags for DELETE /posts/:slug — kept for API compatibility; a post owns no media now. */
export const deletePostQuerySchema = z.object({ purgeMedia: z.enum(["true", "1"]).optional() });

/** Query flags for DELETE /works/:id — force opts into deleting a Work a post still references. */
export const deleteWorkQuerySchema = z.object({ force: z.enum(["true", "1"]).optional() });

export const createProjectSchema = z.object({
	title: z.string().min(1).max(255),
	slug: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[a-z0-9-]+$/, "Slug: lowercase letters, numbers, hyphens"),
	description: z.string().max(50000).optional().default(""),
	thumbnail: z.string().max(500).optional().default(""),
	/**
	 * The full upload the Project image was framed from, kept for repositioning. Owner-facing
	 * only; the detail route withholds it from anyone but the creator.
	 */
	thumbnailSource: z.string().max(500).optional().default(""),
	/** The window the Project image was framed at, so a reposition reopens where it was left. */
	thumbnailCrop: imageCropSchema.nullable().optional(),
	pageConfig: z.record(z.unknown()).optional(),
	// The Project's two sort settings (2026-10-19). A creator saves these from the sort
	// dropdown on the Project page; the detail route applies them when it serializes
	// members, so the choice governs what readers see. `manual` leaves the stored drag
	// order alone (the column default).
	worksSortMode: z.enum(PROJECT_SORT_MODES).optional(),
	worksSortDirection: z.enum(PROJECT_SORT_DIRECTIONS).optional(),
	postsSortMode: z.enum(PROJECT_SORT_MODES).optional(),
	postsSortDirection: z.enum(PROJECT_SORT_DIRECTIONS).optional(),
	isPublished: z.boolean().optional().default(false),
});

export const updateProjectSchema = createProjectSchema.partial().extend({
	/**
	 * A thumbnail chosen from one of the Project's Works, by reference. Null clears the
	 * choice and returns the Project to its uploaded `thumbnail`, which this never clears.
	 */
	thumbnailWorkId: z.number().int().positive().nullable().optional(),
});

/**
 * A comment, or a reply when `replyTo` names the comment it answers. A reply is a comment whose
 * subject is another comment, so it goes through the same route and the same limits.
 */
export const createCommentSchema = z.object({
	body: z.string().min(1).max(COMMENT_MAX),
	replyTo: z.number().int().positive().optional(),
});
/**
 * A review: a verdict, and optionally the words that explain it.
 *
 * ⭐ **Text is optional** (Parker, 2026-10-19). A verdict alone is a review: it
 * counts in the Work's recommended share and Recent share, and it simply does
 * not appear in the public list, where only reviews with text belong. Plain
 * text, no markup, so no sanitizer.
 *
 * ⚠️ The accepted verdicts come from `REVIEW_VERDICTS` rather than being spelled
 * here, so what the API accepts and what the published record may carry cannot
 * drift apart.
 */
export const createReviewSchema = z.object({
	verdict: z.string().refine(isReviewVerdict, "A review recommends the work or does not"),
	body: z.string().trim().max(REVIEW_MAX).optional(),
});

export const createAssetSchema = z.object({
	file: z.string().min(1).max(500),
	filename: z.string().min(1).max(255),
	fileSize: z.number().int().optional().default(0),
	mimeType: z.string().max(100).optional().default(""),
	platform: z.string().max(50).optional().default(""),
	version: z.string().max(50).optional().default(""),
	isPrimary: z.boolean().optional().default(false),
});

export const addWorkToProjectSchema = z.object({
	workId: z.number().int(),
	sortOrder: z.number().int().optional(),
});

export const addPostToProjectSchema = z.object({
	postId: z.number().int(),
	sortOrder: z.number().int().optional(),
});

// ─── Content library items ────────────────────────────────────────────────────

/**
 * `projects.id`, QUALIFIED, for the correlated subquery below.
 *
 * ⚠️ **This is hardening, not a bug fix — the query was never wrong.** Drizzle renders an
 * interpolated `${table.id}` as bare `"id"` **only when the query has a single table in
 * its FROM**; the moment a join is present it qualifies, and this query joins `users`.
 * Verified with `toSQL()` in both shapes rather than assumed.
 *
 * It is written explicitly anyway because the correctness is currently a *side effect of
 * the join*: remove or restructure that join — denormalize the creator name, say — and the
 * identifier silently goes bare, binding project_posts.id, which exists. Postgres raises
 * nothing and every count becomes a plausible constant. That is exactly what happened in
 * `routes/accounts.ts`, whose listings had no join and read 0 for months (PR #223).
 */
export const projectsId = sql`${sql.identifier("projects")}.${sql.identifier("id")}`;

export type WorkRow = typeof works.$inferSelect;
export type AssetRow = typeof workAssets.$inferSelect;
export type TranscodingJobRow = typeof workTranscodingJobs.$inferSelect;
export type WebBuildRow = typeof workBuilds.$inferSelect;
export type WebBuildFileRow = typeof workBuildFiles.$inferSelect;
/** One browser build plus its files, the shape the owner-facing serializer carries. */
export type WebBuildWithFiles = WebBuildRow & { files: WebBuildFileRow[] };

/** The Catalog's own filters, plus a preview. Same "publish the types" purpose. */
/**
 * The preview parameters, declared for the RPC client.
 *
 * ⚠️ This exists to publish the *types*, not to parse: `previewRequest` below still reads
 * the raw query, because three routes accept a preview and only one of them can carry this
 * validator without changing its own signature. Everything is optional and unconstrained
 * here, so it can never reject a request — the real validation is `previewRequest`, which
 * fails back to "no preview" on anything it doesn't recognize.
 */
export const previewQuerySchema = z.object({
	previewAs: z.string().optional(),
	previewOwned: z.string().optional(),
	/**
	 * A **share link** token. Declared here so the RPC client can send it; it is read by
	 * `requesterFor`, which refuses a token naming a different Work.
	 */
	share: z.string().optional(),
});

export const catalogQuerySchema = previewQuerySchema.extend({
	sort: z.string().optional(),
	type: z.string().optional(),
});

/** How the tag directory is asked for: a substring and a page size, both bounded. */
export const tagDirectoryQuerySchema = z.object({
	q: z.string().max(64).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

/**
 * A creator's **preview** request, if they made one.
 *
 * The View As row's shapes (Parker, 2026-10-16): `?previewAs=unlocked` for a user who has
 * cleared every gate and bought it, `?previewAs=locked` for one who has given nothing and
 * bought nothing, `?previewAs=out` for signed-out, and the retired slider's
 * `?previewAs=<amount>` still resolving for old links. Absent or malformed → null, and
 * the user sees the truth, which is the only safe way for this to fail.
 */

export const VOTE_SUBJECTS = ["post", "comment", "review"] as const;
export type VoteSubject = (typeof VOTE_SUBJECTS)[number];

export const voteTargetSchema = z.object({
	subjectType: z.enum(VOTE_SUBJECTS),
	subjectId: z.number().int().positive(),
});
/** Query params arrive as strings, so the id is coerced rather than rejected. */
export const voteQuerySchema = z.object({
	subjectType: z.enum(VOTE_SUBJECTS),
	subjectId: z.coerce.number().int().positive(),
});
export const voteSchema = voteTargetSchema.extend({
	direction: z.string().refine(isVoteDirection, "A vote is up or down"),
});
