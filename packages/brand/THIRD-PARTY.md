# Third-party assets

Provenance and licensing for artwork this package carries. Third-party files are **not** covered by the repository's AGPL-3.0 license or its SPDX-header convention; each retains the license of its source.

## The Noun Project — icon artwork

The botanical icons behind `iconSvg`/`iconGroup`/`iconDataUri` are from [The Noun Project](https://thenounproject.com/), obtained under a paid NounPro subscription and **used and redistributed under the Creative Commons Attribution 3.0 license (CC BY 3.0)**.

What this repository carries is the *derived* form: 18 icons normalized into path markup in `src/generated/icons.ts`. That file is a derivative of CC BY 3.0 art and travels under the same condition, so **this is the attribution** — it lives here, with the redistribution, rather than pointing anywhere else.

> Botanical and bee icons by **Monika**, **Rachel Fredericks**, **Natcha Rochana**, **Pong Pong** and **Fauzi Arts**, via The Noun Project, licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

The 18 are drawn from seven collections, and each collection is authored by a single creator — which is why five names cover 648 source icons:

| Collection | Icons in the source set | Creator | Source |
|---|--:|---|---|
| `animals-38481` (bees) | 9 | [Monika](https://thenounproject.com/creator/NameIsMonika/) | [collection 38481](https://thenounproject.com/browse/collection-icon/animals-38481/) |
| `botanical-borders-and-frames-228479` | 131 | [Rachel Fredericks](https://thenounproject.com/creator/hello6109e/) | [collection 228479](https://thenounproject.com/browse/collection-icon/botanical-borders-and-frames-228479/) |
| `floral-borders-242604` | 15 | [Rachel Fredericks](https://thenounproject.com/creator/hello6109e/) | [collection 242604](https://thenounproject.com/browse/collection-icon/floral-borders-242604/) |
| `flower-and-foliage-167008` | 276 | [Natcha Rochana](https://thenounproject.com/creator/rochanaa/) | [collection 167008](https://thenounproject.com/browse/collection-icon/flower-and-foliage-167008/) |
| `grass-289179` | 20 | [Pong Pong](https://thenounproject.com/creator/pong085/) | [collection 289179](https://thenounproject.com/browse/collection-icon/grass-289179/) |
| `wildflowers-outline-271978` | 100 | [Fauzi Arts](https://thenounproject.com/creator/fauziarts/) | [collection 271978](https://thenounproject.com/browse/collection-icon/wildflowers-outline-271978/) |
| `wildflowers-solid-271979` | 97 | [Fauzi Arts](https://thenounproject.com/creator/fauziarts/) | [collection 271979](https://thenounproject.com/browse/collection-icon/wildflowers-solid-271979/) |

🚨 **This table is the attribution of record and must stay in this repository.** The icon library it was copied from is a private repository, so a reader here cannot follow a link into it — and an attribution that points somewhere nobody can reach is not an attribution. **Attribution travels with the redistribution**, and this repository is where the redistribution happens.

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

First-party Anthers brand art (© Parker H. Davis, LLC) — vector masters, the wordmark lockups, and raster exports, with a palette and type note in `marks/README.txt`. An interim in-house design, pending a commissioned one. The layered sources live in a **private** repository rather than here, because that repository mixes Anthers' own working files with licensed third-party art and is not ours to publish as a whole.

## Desktop packaging

The Tauri packaging icons were here as `app-icons/` until 2026-08-14 and moved to [anthers-desktop](https://github.com/anthers-inc/anthers-desktop) with the app. Derived from the Anthers mark above; same first-party provenance.
