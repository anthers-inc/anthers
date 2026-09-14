A byte-for-byte copy of each `org.anthers.*` Lexicon as it was published to the network, laid out the same way as `lexicons/`.

**Only `scripts/atproto-publish-lexicon.ts` writes here**: it copies a schema in at the moment it publishes it and removes the copy when it retires one. `bun run lex:check`, which runs in `make verify` and CI, compares `lexicons/` against these copies and fails on any edit that breaks a published schema — a field removed, renamed, retyped or made required, or a constraint changed. The rules are in `scripts/lexicon-evolution.ts`.

**Never edit a copy by hand to make that check pass.** A copy that no longer matches the network is refused by the publisher before it writes anything, but a hand edit that happens to match the source would hide a breaking change from CI. A schema of the wrong shape is published under a new NSID instead.
