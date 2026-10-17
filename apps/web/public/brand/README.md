# Brand Assets Referenced from Outside This App

🚨 **These paths are stable on purpose and must not be renamed, moved, or run through the
bundler.** Everything the build imports is content-hashed — `lockup-oneline-light-mpamxr9x.png`
and so on — which is right for anything the pages themselves load and wrong for anything a URL is
written down for somewhere else. `public/` is copied verbatim into `dist/`, so what is here
keeps the same address across every deploy.

`anthers-mark-256.png` is the header logo the **identity server** puts in the mail it sends —
the token it mails somebody who is seating a recovery key, and anything else the reference
Personal Data Server mails on its own behalf. It is set as `PDS_LOGO_URL` on the node, which
fills both the header logo and the small mark: with it unset the reference implementation
falls back to Bluesky's own artwork, so somebody confirming an operation on their Anthers
identity would meet a Bluesky-branded email.

⚠️ **A rename here breaks that silently**, in a place nothing in this repository tests and
nobody looks at until somebody reports a broken image in an email. If one of these has to
move, grep the node repository and the Production Operations Runbook for its name first.

Cut from the logo's 1:1 thumb in `packages/brand/logo/preps/` by `bun run brand:logo`, which
records its hash; `scripts/brand-logo.test.ts` fails if it is edited in place.

## The rest of the family

- `og-card.png` is the link-preview image the app shell's meta tags name at
  `https://anthers.org/brand/og-card.png` — the same og:image address appears in every route's
  served head, so its URL is written down for external crawlers. Padded to og's 1200×630 from
  the 1:1 thumb, with the pad taking the prep's own background. A platform that caches it
  keeps the address; improve the card by re-exporting a prep and rerunning `bun run brand:logo`.
- `icon-192.png` and `icon-512.png` are named by the app's `site.webmanifest` — the
  home-screen icon registry for surfaces that read one (Android share-to-home-screen,
  install prompts). Same rule: the manifest names their root-absolute addresses, and
  nothing rewrites them on deploy.

Both are cut from the same thumb prep as the tab icons; if one of these moves, grep the app
shell's meta tags and the manifest first.
