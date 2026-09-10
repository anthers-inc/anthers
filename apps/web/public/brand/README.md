# Brand assets referenced from outside this app

🚨 **These paths are stable on purpose and must not be renamed, moved, or run through the
bundler.** Everything the build imports is content-hashed — `anthers-lockup-mpamxr9x.png` and
so on — which is right for anything the pages themselves load and wrong for anything a URL is
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

Derived from `packages/brand/marks/export/anthers-mark-1024.png`, which is the source of
truth for the mark. Regenerate rather than editing in place.
