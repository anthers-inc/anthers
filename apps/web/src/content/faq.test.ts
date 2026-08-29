// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the FAQ pool may say, given the model we have.
//
// 🚨 **These answers became four surfaces on 2026-08-28, and that is what earns them a
// test.** While the FAQ was one page, a wrong answer was one wrong page. It now renders on
// the homepage, /for-creators, /subscribe and /faq, so a claim that goes stale here goes
// stale on the four pages a visitor is most likely to read — and unlike the marketing
// prose around it, this copy is a long way from the section that would contradict it.
//
// Scoped the way `about-claims.test.ts` is scoped, and for the same reason: `RETIRED_COPY`
// in `scripts/econ-figures.ts` runs repo-wide and already covers the vocabulary (Seeds,
// watch-time, "federated", pay-what-you-want, Anthers Gates), so nothing here repeats it.
// What is left is the handful of rules that are **about this file's claims** rather than
// about words, and each one below is a rule 63.01 states and a regex can actually check.
//
// ⚠️ The assertions read the RENDERED text, not the source, which matters for the answers
// written as JSX: a rule checked against source would miss every claim that arrives inside
// a `<strong>`, and about half of the load-bearing sentences here do.
//
// Sources: 63.01 § Claims & honesty (co-presence, take-home, Public Access), § Words.

import { describe, expect, it } from "bun:test";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { isValidElement, type ReactNode } from "react";
import { ALL_FAQ_ITEMS, type FAQItem, type FAQSurface, faqFor, PAGE_FAQS } from "./faq";

/**
 * The words of an answer, whether it was written as a string or as JSX.
 *
 * Walks `props.children` rather than rendering, so the test needs no DOM and no
 * `react-dom`. Whitespace is collapsed for the same reason `about-claims.test.ts`
 * collapses it: JSX text wraps wherever the formatter decides, and a phrase split across
 * two lines is invisible to a substring scan — a guard that a reflow can disarm has
 * stopped being a guard.
 */
function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	if (isValidElement(node)) {
		return textOf((node.props as { children?: ReactNode }).children);
	}
	return "";
}

const answerText = (item: FAQItem) => textOf(item.answer).replace(/\s+/g, " ");
const words = (item: FAQItem) => `${item.question} ${answerText(item)}`.toLowerCase();

const SURFACES: FAQSurface[] = ["users", "creators", "signup"];

describe("the FAQ pool", () => {
	it("gives every question a question and an answer with words in it", () => {
		for (const item of ALL_FAQ_ITEMS) {
			expect(`${item.question} ends in a question mark`).toBe(
				`${item.question.trim().endsWith("?") ? item.question : `${item.question}?`} ends in a question mark`,
			);
			// A JSX answer whose children never resolve to text renders as an empty
			// disclosure — it opens onto nothing, and nothing else in the app would say so.
			// Reported with the question attached so a failure names the row.
			expect(`${item.question} → ${answerText(item).length > 80}`).toBe(`${item.question} → true`);
		}
	});

	it("asks each question once", () => {
		const asked = ALL_FAQ_ITEMS.map((i) => i.question.toLowerCase());
		expect(new Set(asked).size).toBe(asked.length);
	});

	// The pruning rule from `PAGE_FAQS`, asserted from both ends. Too few and the section
	// is a stub that would read better as a link; too many and it is a second FAQ page
	// pretending to be a summary, which is the failure the shared pool was meant to avoid
	// rather than cause.
	for (const surface of SURFACES) {
		it(`gives /${surface} a shortlist rather than the whole FAQ`, () => {
			const items = faqFor(surface);
			expect(items.length).toBeGreaterThanOrEqual(4);
			expect(items.length).toBeLessThanOrEqual(8);
			expect(new Set(PAGE_FAQS[surface]).size).toBe(PAGE_FAQS[surface].length);
		});
	}

	// 🚨 63.01's co-presence rule, and the one most likely to be broken by an edit that
	// looks like tightening. "Free forever" with no bound beside it reads as unlimited,
	// and the bound is the entire reason anybody gives Anthers the Public Access price —
	// so hiding it hollows out the offer as well as overstating it. Conditional on the
	// phrase, because dropping the promise is a legitimate edit and dropping the limit
	// while keeping the promise is not.
	it("never promises 'free forever' without a bound in the same answer", () => {
		for (const item of ALL_FAQ_ITEMS) {
			const text = words(item);
			if (!text.includes("free forever")) continue;
			expect(`${item.question}: ${text.includes(`${FREE_PUBLIC_ACCESS_HOURS} hours`)}`).toBe(
				`${item.question}: true`,
			);
		}
	});

	// 🚨 Public Access is a property of the CONTENT, never of a viewer's entitlement, so
	// supporting Anthers cannot open, unlock or get you any of it — it was already free to
	// everyone, and what lifts is the cap on a free account's own streaming. The verbs are
	// the tell, and they are what a well-meaning edit reaches for, because every other
	// subscription on the internet works the other way.
	it("never describes supporting Anthers as unlocking Public Access", () => {
		const forbidden = [
			/(?:unlocks?|unlocking|opens?|opening|gets? you|grants?) (?:you )?(?:unlimited |full )?public access/i,
			/public access (?:is )?(?:unlocked|granted)/i,
		];
		for (const item of ALL_FAQ_ITEMS) {
			for (const pattern of forbidden) {
				expect(`${item.question}: ${pattern.test(answerText(item)) ? "claims it" : "clean"}`).toBe(
					`${item.question}: clean`,
				);
			}
		}
	});

	// 🚨 "No cut" beside a price, with no take-home number, is 63.01's single easiest way
	// to turn a true claim into a false impression: a reader who meets *0% cut* next to
	// *$20* concludes the creator receives $20. Both answers that pair them state the
	// figure, and they must keep doing so — including when one is reworded, which is when
	// a dollar amount is most likely to be dropped as clutter.
	it("never states a cut beside a price without the take-home figure", () => {
		for (const item of ALL_FAQ_ITEMS) {
			const text = answerText(item);
			const claimsNoCut = /0% (?:platform fee|cut)|takes no cut/i.test(text);
			const namesAPrice = /\$\d/.test(text);
			if (!claimsNoCut || !namesAPrice) continue;
			// At least two money figures: a price is only safe here beside what actually
			// arrives, so one lone number is the shape this rule exists to catch.
			const figures = text.match(/\$\d+(?:\.\d{2})?/g) ?? [];
			expect(`${item.question}: ${figures.length} figures`).not.toBe(`${item.question}: 1 figures`);
		}
	});

	// The positive half, and it needs asserting for the reason every negative rule needs
	// one: each assertion above could be satisfied by an empty pool. These are the two
	// claims the shortlists are built around — delete either answer and a page's FAQ loses
	// the thing it was assembled to say. Rewording is fine; update the phrase here with it.
	it("still answers the two questions the pages are built around", () => {
		const takeHome = ALL_FAQ_ITEMS.find((i) => i.question.includes("How much do creators keep"));
		expect(words(takeHome!)).toContain("0% platform fee");

		const free = faqFor("signup")[0];
		expect(free.question.toLowerCase()).toContain("card");
		expect(words(free)).toContain("no.");
	});
});
