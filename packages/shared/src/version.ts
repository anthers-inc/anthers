// SPDX-License-Identifier: Apache-2.0
/**
 * The version of Anthers production is declared to run — calver, `YYYY.M.N`.
 *
 * 🚨 **This is a committed constant, not something computed from git at build time.**
 * The web bundle is built on DigitalOcean App Platform, from its own clone of the
 * `release` branch — a clone whose git state nobody here controls and that carries no
 * guarantee of tags. A version baked from `git describe` there would silently fall
 * back to nothing on the day the clone shape changes, and a footer that can render
 * `unknown` is worse than one that renders a constant a human bumped. The tag and the
 * build agree by construction instead: CI's deploy job tags the deployed commit with
 * exactly this string, from the same commit, at deploy time.
 *
 * The flow that keeps it current:
 *
 * 1. A promote bumps this constant on `main` (see `scripts/promote-version.ts`).
 * 2. The promote pushes `main` to `release`, which is what App Platform builds.
 * 3. CI's `deploy` job, on a green verified deploy, tags that commit `v<APP_VERSION>`.
 * 4. The deployed bundle already carried the constant — footer and tag cannot disagree.
 *
 * ⚠️ **Calver chosen over semver deliberately (Parker, 2026-10-01), for every Anthers
 * repo.** The version's audience is the changelog, release notes and a support
 * question, all of which want "when did this ship" rather than a compatibility
 * promise — Anthers is one hosted deployment, not a distributed library. The string
 * is also valid semver (`2026.10.0` parses), which is why the desktop app and the
 * creator node can carry the same scheme without fighting their tooling. Each repo
 * numbers independently; only the scheme is shared.
 *
 * `APP_VERSION_SHAPE.test.ts` pins the constant to the calver shape, so a typo in a
 * bump fails the build rather than shipping a footer that reads `202.10.0`.
 */
export const APP_VERSION = "2026.10.1";
