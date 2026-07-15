// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context } from "hono";
import type { ZodError } from "zod";

/**
 * A @hono/zod-validator failure hook that returns the first validation issue as a
 * plain `{ error }` STRING (e.g. "Invalid email"), with a 400.
 *
 * The default hook responds with the raw `ZodError`, whose `issues` don't survive
 * JSON serialization — so it reaches the client as `{}` and renders as
 * "[object Object]". Pass this as the 3rd arg to `zValidator` on form-backed routes
 * so validation errors are actionable (paired with the client's `errorText` in
 * web-shared/auth.tsx, which already prefers a string `error`).
 */
export function invalidBody(
	result: { success: true } | { success: false; error: ZodError },
	c: Context,
) {
	if (!result.success) {
		return c.json({ error: result.error.issues[0]?.message ?? "Invalid input" }, 400);
	}
}
