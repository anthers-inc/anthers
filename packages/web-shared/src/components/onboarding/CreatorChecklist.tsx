// SPDX-License-Identifier: Apache-2.0
/**
 * The creator's checklist on the Studio's Works page, in two phases and one corner.
 *
 * ⭐ **The required pair first, then the steps that make a catalog.** While publishing is
 * refused for want of the ATProto grant or payout setup, the card is those two rows and is
 * not dismissible: they are the gate, and the server refuses a release for the same reasons
 * (`publishRefusal`). Once both are answered the same card becomes **Creator First Steps**,
 * which is guidance and can be put away — one card reading as one sequence rather than two
 * designs competing for the page.
 *
 * ⚠️ **Only on the Works page.** The Studio's front door is where a creator lands, and the
 * Work editor already carries its own floating checklist in the same corner; a second card
 * there would stack two overlays on one screen.
 */
import { useState } from "react";
import { useAuth } from "../../lib/auth";
import {
	checklistComplete,
	creatorChecklistItems,
	dismissOnboardingChecklist,
	useOnboardingFacts,
} from "../../lib/onboarding";
import { usePayoutsReady } from "../../lib/payouts";
import { usePublishingPermissionMissing } from "../../lib/publishing";
import { studioUrl } from "../../lib/studio";
import SetupChecklist, {
	checklistCornerClass,
	type SetupChecklistItem,
} from "../ui/SetupChecklist";

export default function CreatorChecklist({ playerUp }: { playerUp: boolean }) {
	const { user, refreshUser } = useAuth();
	const payoutsReady = usePayoutsReady();
	const permissionMissing = usePublishingPermissionMissing();
	const onboardingFacts = useOnboardingFacts();
	const [dismissed, setDismissed] = useState(false);

	// The two gate answers arrive a moment after the page; until both have answered there is
	// no card rather than a guessed one.
	if (payoutsReady === null || permissionMissing === null) return null;

	const setupItems: SetupChecklistItem[] = [
		{
			key: "permission",
			label: "Allow ATProto creator permissions",
			state: permissionMissing ? "todo" : "done",
			href: studioUrl("/settings"),
		},
		{
			key: "payouts",
			label: "Complete your Stripe Payout Setup",
			state: payoutsReady ? "done" : "todo",
			href: studioUrl("/payments"),
		},
	];

	if (payoutsReady === false || permissionMissing === true) {
		return (
			<div className={checklistCornerClass(playerUp)}>
				<SetupChecklist
					title="Creator Setup Checklist"
					intro="Before you can publish Works or posts, you need to:"
					items={setupItems}
				/>
			</div>
		);
	}

	if (!user || !onboardingFacts || dismissed || user.creatorChecklistDismissedAt) return null;
	const items = creatorChecklistItems(onboardingFacts, user);
	if (checklistComplete(items)) return null;

	const dismiss = () => {
		setDismissed(true);
		void dismissOnboardingChecklist("creator").then((ok) => {
			if (!ok) setDismissed(false);
			else void refreshUser();
		});
	};

	return (
		<div className={checklistCornerClass(playerUp)}>
			<SetupChecklist
				title="Creator First Steps"
				intro="Your account can publish now. These are the steps that put something in front of people."
				items={items}
				onDismiss={dismiss}
			/>
		</div>
	);
}
