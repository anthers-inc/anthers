// SPDX-License-Identifier: Apache-2.0
/**
 * Keeping a detection vendor's Match Data out of errors.
 *
 * 🛑 **Match Data must never reach an agent**, and the Agents Hub carries why: Shield's terms
 * forbid using it as input to generative AI. Not selecting `vendor_match` keeps it out of reads.
 * This keeps it out of failures, which leak it without anybody selecting anything: a Drizzle
 * error's message quotes the query's parameters, so a write carrying `vendorMatch` that fails
 * puts the vendor's answer into whatever logs or stores the error — a worker log, a job's saved
 * error, an operator's screen.
 *
 * So every write carrying `vendorMatch` goes through {@link writingMatchData}, and a failure is
 * rethrown as {@link MatchDataWriteError}: a message naming what was being written and the
 * SQLSTATE, and no `cause`.
 */

/**
 * Why something failed, in a form safe to show and to log.
 *
 * 🚨 **A failed query is described by its SQLSTATE and nothing else.** Drizzle's message quotes
 * the parameters, and even Postgres's own message quotes a value for some refusals, so the code
 * is the only part guaranteed to carry none. Anything else is its first line.
 */
export function safeFailureReason(err: unknown): string {
	if (!(err instanceof Error)) return "an unknown error";
	const code = [err, err.cause]
		.map((e) => (e as { code?: unknown } | undefined)?.code)
		.find((c): c is string => typeof c === "string" && /^[0-9A-Z]{5}$/.test(c));
	if (code) return `the database refused it (SQLSTATE ${code})`;
	if (err.message.startsWith("Failed query")) return "the database refused it";
	return err.message.split("\n")[0].replace(/\.$/, "");
}

/** A write carrying Match Data failed. Deliberately without a `cause` — see the module note. */
export class MatchDataWriteError extends Error {
	constructor(what: string, failure: unknown) {
		super(`Writing ${what} failed: ${safeFailureReason(failure)}.`);
	}
}

/** Run a write that carries `vendorMatch`, rethrowing any failure without the values it carried. */
export async function writingMatchData<T>(what: string, write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (err) {
		throw new MatchDataWriteError(what, err);
	}
}
