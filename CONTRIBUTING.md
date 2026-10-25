# Contributing

**Anthers is not accepting code contributions right now.** That is a temporary state and worth explaining, because "public repo, closed to PRs" is an unusual combination and it would be easy to read it as unfriendliness.

## Why It's Closed for the Moment

The platform is pre-launch and pre-general-availability. The economic model, the database schema and the product surface have all moved substantially in the last few months — gates retired, delivery costs deleted, an entire content model re-founded — and they will move again before launch. Accepting an outside pull request against that would mean asking someone to spend real effort building on a foundation still being poured, then watching it get rewritten underneath them. We would rather not spend anyone's time that way.

It is also an honesty problem. Anthers is run by one person. A contribution that sits unreviewed for weeks is worse than one that was never invited, and an open-door sign we cannot actually staff is a promise broken slowly.

So the door is closed for now, deliberately, and it will open. Building in the open is a stated goal of this project rather than a nice-to-have — when the platform reaches general availability and the ground stops shifting, the [README's Status section](./README.md#status) is where the invitation will appear.

## What Is Open, Today

- **Security reports.** Always in scope, always welcome, whatever else is going on — see [`SECURITY.md`](./SECURITY.md).
- **Reading the code.** That is what the [license](./LICENSE.md) is for. Fork it, run it, learn from it, take it apart.
- **Questions and comments.** [contact@anthers.org](mailto:contact@anthers.org) reaches a person.

If you have found a real bug in the platform, tell us — a good bug report is a genuine contribution and we would rather have it than not. Just expect it to be fixed by us rather than merged from you, for now.

## If You Are Running It Anyway

`make dev` brings up the whole thing on your own machine — Postgres, migrations, the API, the worker and the web app. `make verify` runs exactly what CI runs, in the same order. The [README](./README.md#running-it-locally) has the rest.

Two things about the code that are worth knowing before you read much of it:

- **Published money figures are derived, never typed.** Every dollar amount on the site and in this README comes from `packages/shared/src/fees.ts`, through the plain-number tables in `packages/shared/src/figures.ts`. If you move a dial, update that file and every page that quotes a figure in the same change; periodic drift passes reconcile the two. If you find yourself computing a figure by hand, that is the cue to read the model, not a formatting choice.
- **Comments cite documents by name, and nearly all of those are public.** References like *Content Standards* or *The Rating Standard* point at pages in Anthers' public wiki, which you can read; a few name an internal document instead and say so on the line, the child-safety coverage map being the main one. Either way they are provenance rather than prerequisites: every comment that cites one also explains itself first, and if you find one that does not, that is a documentation bug worth reporting. **Comments used to cite bare numbers like `40.09`**, pointing into an internal register that no longer exists — if you find one that survived the sweep, that is worth reporting too.

Thank you for looking. Come back when the sign flips.
