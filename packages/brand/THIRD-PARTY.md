# Third-party assets

Provenance and licensing for artwork this package carries. Third-party files are **not** covered by the repository's AGPL-3.0 license or its SPDX-header convention; each retains the license of its source.

## The Noun Project — icon artwork

The botanical icons behind `iconSvg`/`iconGroup`/`iconDataUri` are from [The Noun Project](https://thenounproject.com/), obtained under a paid NounPro subscription and **used and redistributed under the Creative Commons Attribution 3.0 license (CC BY 3.0)**.

**The full attribution — every collection, its creator, and links to both — lives with the art, in [anthers-inc/Anthers-Brand](https://github.com/anthers-inc/Anthers-Brand).** What this repository carries is the *derived* form: 18 icons normalized into path markup in `src/generated/icons.ts`. That file is a derivative of CC BY 3.0 art and so travels under the same condition, which is why the credit is restated here rather than only in the other repo:

> Botanical and bee icons by **Monika**, **Rachel Fredericks**, **Natcha Rochana**, **Pong Pong** and **Fauzi Arts**, via The Noun Project, licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

### Why we attribute, having paid not to

Researched 2026-08-14, resolving a question this file had carried open since the package was created. An icon on The Noun Project sits under **one of three licenses, chosen by its creator**: Public Domain, **CC BY 3.0**, or — where the creator chose CC BY 3.0 — a **Royalty-Free license a paying subscriber may buy, whose entire effect is to waive the attribution condition** (Terms of Use § 3(A); Icon Creator Terms). The royalty-free option is not a different, more permissive grant. It is CC BY 3.0 with the "BY" bought out.

That distinction is the whole answer for a public repository:

- **The attribution waiver is ours, not our readers'.** It is a contract between Noun Project and the subscriber. Someone who forks this AGPL repository is not a party to it and inherits nothing from it.
- **CC BY 3.0, however, travels.** It grants everyone — irrevocably, worldwide, commercially — the right "to Reproduce the Work, to incorporate the Work into one or more Collections" and "to Distribute and Publicly Perform the Work including as incorporated in Collections", on the single condition of naming the original author (§ 3, § 4(b)).

So attributing costs nothing, and it is what makes this art usable **by the people we hand it to** rather than only by us. The subscription is what lets the icons appear in the product UI without a credit line on every page; the attribution is what makes the repository forkable.

**Do not remove the credit on the grounds that we hold a royalty-free license.** That reasoning is true of Anthers and false of everyone downstream, which is the population a public AGPL repo exists to serve.

Two scoping notes, because both are easy to get backwards:

- **The "Restricted Activities" list is about Photos, not Icons.** The Terms' prohibitions on redistributing images in templates, on using them in logos, and on redistributing an unaltered image as your own artwork are defined "for purposes of this Section 3(B)" — the Photos section. We use no Noun Project photos.
- ⚠️ **Using this art in a trademark is a separate question from redistributing it, and it is not settled here.** CC BY 3.0 grants copyright permissions and expressly grants no trademark rights. The interim Anthers mark was traced from Noun Project source art, which is fine as *use* and is a real question as *a mark to claim exclusively*. The commissioned replacement noted below is the clean answer; until then, do not file on the interim mark without asking counsel.

## Anthers marks (`marks/`)

First-party Anthers brand art (© Parker H. Davis, LLC) — vector masters, the wordmark lockups, and raster exports, with a palette and type note in `marks/README.txt`. An interim in-house design, pending a commissioned one. The layered sources are in [Anthers-Brand](https://github.com/anthers-inc/Anthers-Brand) rather than here.

## Desktop packaging (`app-icons/`)

Derived from the Anthers mark above; same first-party provenance.
