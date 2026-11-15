// SPDX-License-Identifier: Apache-2.0
/**
 * **Getting Around Anthers** — the reader's orientation checklist, floating in the shell's
 * lower-right corner.
 *
 * ⭐ **This is orientation, not a gate.** Nothing on it stands between a reader and any
 * act, so it is dismissible and every row is answered by a fact about the account rather
 * than by a click (`lib/onboarding.ts` owns how). The card is drawn while any row is open
 * and the account has not put it away, which is what makes the dismissal the one thing the
 * reader owns here.
 *
 * ⚠️ **The shell mounts it in user mode only.** The Studio has its own checklist, and two
 * cards in one corner would be the vocabulary arguing with itself.
 */
import { useState } from "react";
import { useAuth } from "../../lib/auth";
import {
	checklistComplete,
	dismissOnboardingChecklist,
	readerChecklistItems,
	useOnboardingFacts,
} from "../../lib/onboarding";
import SetupChecklist, { checklistCornerClass } from "../ui/SetupChecklist";

export default function ReaderChecklist({ playerUp }: { playerUp: boolean }) {
	const { user, refreshUser } = useAuth();
	const onboardingFacts = useOnboardingFacts();
	const [dismissed, setDismissed] = useState(false);

	// Nothing draws until the account is known and its facts have answered: a checklist that
	// guessed would meet a returning reader with an empty progress bar over work they did.
	if (!user || !onboardingFacts || dismissed || user.readerChecklistDismissedAt) return null;
	const items = readerChecklistItems(onboardingFacts, user);
	if (checklistComplete(items)) return null;

	const dismiss = () => {
		setDismissed(true);
		void dismissOnboardingChecklist("reader").then((ok) => {
			// A refusal puts the card back rather than leaving the page claiming a dismissal
			// the account never recorded.
			if (!ok) setDismissed(false);
			else void refreshUser();
		});
	};

	return (
		<div className={checklistCornerClass(playerUp)}>
			<SetupChecklist
				title="Getting Around Anthers"
				intro="A few things to try while you look around. Nothing here is required."
				items={items}
				onDismiss={dismiss}
				dismissLabel="I know my way around"
			/>
		</div>
	);
}
