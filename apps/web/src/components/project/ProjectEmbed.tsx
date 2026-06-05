// SPDX-License-Identifier: AGPL-3.0-or-later
import { PlayIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { useState } from "react";

interface ProjectEmbedProps {
	embedUrl: string;
	title: string;
}

export default function ProjectEmbed({ embedUrl, title }: ProjectEmbedProps) {
	const [active, setActive] = useState(false);

	if (!active) {
		return (
			<div className="relative bg-base-300 rounded-lg overflow-hidden">
				<div className="flex flex-col items-center justify-center py-16 gap-4">
					<button
						type="button"
						className="btn btn-primary btn-lg gap-2"
						onClick={() => setActive(true)}
					>
						<PlayIcon className="w-6 h-6" />
						Play in Browser
					</button>
					<p className="text-sm text-base-content/50">Runs in a sandboxed iframe</p>
				</div>
			</div>
		);
	}

	return (
		<div className="relative bg-black rounded-lg overflow-hidden">
			<div className="flex justify-end p-1 bg-base-300">
				<button type="button" className="btn btn-ghost btn-xs" onClick={() => setActive(false)}>
					<XMarkIcon className="w-4 h-4" />
					Close
				</button>
			</div>
			<iframe
				src={embedUrl}
				title={title}
				className="w-full"
				style={{ height: "480px" }}
				sandbox="allow-scripts allow-same-origin allow-popups"
				allowFullScreen
			/>
		</div>
	);
}
