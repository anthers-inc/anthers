// SPDX-License-Identifier: Apache-2.0
import { PlayIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { useState } from "react";

interface ProjectEmbedProps {
	embedUrl: string;
	title: string;
	/**
	 * Mounted inside the Work page's fixed 16:9 media stage (the standard-profile
	 * task, 2026-10-19): the frame takes the stage's remaining height rather than
	 * deriving its own `aspect-video` height beside the close bar. The embed page's
	 * bare window leaves this off and keeps the picture-derived height.
	 */
	fillsFrame?: boolean;
}

export default function ProjectEmbed({ embedUrl, title, fillsFrame = false }: ProjectEmbedProps) {
	const [active, setActive] = useState(false);

	const idle = (
		<>
			<button
				type="button"
				className="btn btn-primary btn-lg gap-2"
				onClick={() => setActive(true)}
			>
				<PlayIcon className="w-6 h-6" />
				Play in Browser
			</button>
			<p className="text-sm text-base-content/50">Runs in a sandboxed iframe</p>
		</>
	);

	if (!active) {
		return fillsFrame ? (
			<div className="flex h-full w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-lg bg-base-300">
				{idle}
			</div>
		) : (
			<div className="relative overflow-hidden rounded-lg bg-base-300">
				<div className="flex flex-col items-center justify-center gap-4 py-16">{idle}</div>
			</div>
		);
	}

	return (
		<div
			className={`flex flex-col overflow-hidden rounded-lg bg-black ${fillsFrame ? "h-full w-full" : ""}`}
		>
			<div className="flex shrink-0 justify-end bg-base-300 p-1">
				<button type="button" className="btn btn-ghost btn-xs" onClick={() => setActive(false)}>
					<XMarkIcon className="w-4 h-4" />
					Close
				</button>
			</div>
			{/* The sandbox keeps `allow-same-origin` beside `allow-scripts` on purpose: a web build keeps
			    its saves in its own origin's storage and breaks without it. The pair is only safe while
			    the build's origin differs from this page's, which is why `embedUrlProblem` in
			    `@anthers/shared/content` refuses anything on Anthers' own domain. Change the two
			    together. */}
			<iframe
				src={embedUrl}
				title={title}
				// Inside the stage the play area takes the height left by the close bar; on
				// the bare embed route it keeps drawing the video profile itself.
				className={fillsFrame ? "min-h-0 w-full flex-1" : "aspect-video w-full"}
				sandbox="allow-scripts allow-same-origin allow-popups"
				allowFullScreen
			/>
		</div>
	);
}
