// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Meadow web families. Reference by inline `fontFamily` (e.g. the Fraunces
// display serif over the Nunito Sans body). Kept here so the shared
// decor/economics components and the marketing pages stay in lockstep on
// typography.
//
// Loaded by `apps/web` only, from self-hosted files — see
// apps/web/public/fonts/THIRD-PARTY.md for why they are not on a CDN. The Studio
// (`apps/studio-web`) carries no font link and never has, so there these resolve
// to their fallbacks (Georgia, system-ui). Every entry therefore needs a fallback
// stack that stands on its own.

export const FONTS = {
	fraunces: '"Fraunces", Georgia, "Times New Roman", serif',
	nunito: '"Nunito Sans", system-ui, -apple-system, sans-serif',
	spectral: '"Spectral", Georgia, serif',
	caveat: '"Caveat", "Segoe Script", cursive',
};
