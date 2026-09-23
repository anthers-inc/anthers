// SPDX-License-Identifier: Apache-2.0
/**
 * Mapping a credit acceptance onto its public `org.anthers.creditAcceptance` record.
 *
 * A `did`-naming credit on a Work is a claim about a third party, so the Work listing withholds
 * it until that third party accepts. The acceptance record lives in the CONTRIBUTOR's own
 * repository, not the work author's — it is the contributor saying "yes, I did this."
 *
 * ⚠️ This is a pure function and writes nothing. The record shape is validated against the
 * generated Lexicon before any sync tries to write it.
 */
import type { CreditAcceptanceRecordValue } from "@anthers/shared/lexicons";

export const CREDIT_ACCEPTANCE_COLLECTION = "org.anthers.creditAcceptance";

/** What a credit acceptance needs to build its record. */
export interface PublishableCreditAcceptance {
	/** The address of the Work listing the contributor is accepting credit for. */
	workUri: string;
	/** What the contributor agrees they did, as the creator asserted it. */
	role: string;
	/** When the contributor accepted. */
	acceptedAt: Date;
}

/**
 * The public acceptance record shape.
 *
 * ⚠️ Kept as an explicit struct rather than {@link CreditAcceptanceRecordValue} because the
 * generated type brands `work` and `acceptedAt` with `l.AtUriString` / `l.DatetimeString`, which
 * are `string` subtypes that TypeScript refuses to assign a plain string to. The runtime
 * validator accepts the same strings, so the local type mirrors the generated shape without
 * the branded nominal types.
 */
export interface CreditAcceptanceRecord {
	$type: "org.anthers.creditAcceptance";
	work: string;
	role: string;
	acceptedAt: string;
}

/** Why an acceptance cannot be published as a record. */
export type UnpublishableCreditAcceptanceReason = "missing_work" | "missing_role";

/**
 * Decide why an acceptance is not publishable, or `null` when it is.
 *
 * Exported so the planner can share the same validity check the mapper uses.
 */
export function unpublishableCreditAcceptanceReason(
	input: PublishableCreditAcceptance,
): UnpublishableCreditAcceptanceReason | null {
	if (!input.workUri.trim()) return "missing_work";
	if (!input.role.trim()) return "missing_role";
	return null;
}

/**
 * Build the public acceptance record, or `null` when it must not have one.
 *
 * 🚨 The address is an `at://` URI pointing at the Work's listing, not at the Work row. A
 * listing exists only while the Work is publicly listed, so an acceptance is about the public
 * record rather than the private Work.
 */
export function creditAcceptanceToRecord(
	input: PublishableCreditAcceptance,
): CreditAcceptanceRecord | null {
	if (unpublishableCreditAcceptanceReason(input) !== null) return null;
	return {
		$type: "org.anthers.creditAcceptance",
		work: input.workUri,
		role: input.role,
		acceptedAt: input.acceptedAt.toISOString(),
	};
}
