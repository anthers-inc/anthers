// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	ListBulletIcon,
	MagnifyingGlassMinusIcon,
	MagnifyingGlassPlusIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";

/**
 * Heading extracted from markdown content.
 */
interface Heading {
	id: string;
	text: string;
	level: number;
}

/**
 * Props for the WikiRightSidebar component.
 */
interface WikiRightSidebarProps {
	/** Markdown content for TOC extraction */
	content: string;
	/** Previous page info */
	previousPage: { section: string; file: string; name: string } | null;
	/** Next page info */
	nextPage: { section: string; file: string; name: string } | null;
	/** Navigation callback */
	onNavigate: (section: string, file: string) => void;
	/** Current zoom level (1.0 = 100%) */
	zoomLevel: number;
	/** Callback when zoom changes */
	onZoomChange: (zoom: number) => void;
}

/**
 * Combined right sidebar for wiki pages.
 * Contains view controls (navigation, zoom) at the top,
 * followed by a divider and the table of contents.
 */
export default function WikiRightSidebar({
	content,
	previousPage,
	nextPage,
	onNavigate,
	zoomLevel,
	onZoomChange,
}: WikiRightSidebarProps) {
	const [headings, setHeadings] = useState<Heading[]>([]);
	const [activeId, setActiveId] = useState<string>("");

	// Zoom presets
	const ZOOM_MIN = 0.75;
	const ZOOM_MAX = 1.5;
	const ZOOM_STEP = 0.05;

	const handleZoomIn = () => {
		onZoomChange(Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP));
	};

	const handleZoomOut = () => {
		onZoomChange(Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP));
	};

	const handleZoomReset = () => {
		onZoomChange(1.0);
	};

	// Extract headings from markdown content
	useEffect(() => {
		const headingRegex = /^(#{2,3})\s+(.+)$/gm;
		const extractedHeadings: Heading[] = [];

		for (const match of content.matchAll(headingRegex)) {
			const level = match[1].length;
			const text = match[2].trim();
			const id = text
				.toLowerCase()
				.replace(/[^\w\s-]/g, "")
				.replace(/\s+/g, "-");

			extractedHeadings.push({ id, text, level });
		}

		setHeadings(extractedHeadings);
	}, [content]);

	// Track active heading based on scroll position
	useEffect(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						setActiveId(entry.target.id);
					}
				});
			},
			{ rootMargin: "-80px 0px -80% 0px" },
		);

		headings.forEach(({ id }) => {
			const element = document.getElementById(id);
			if (element) {
				observer.observe(element);
			}
		});

		return () => observer.disconnect();
	}, [headings]);

	const scrollToHeading = (id: string) => {
		const element = document.getElementById(id);
		if (element) {
			element.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	};

	return (
		<aside className="hidden xl:flex bg-base-100 w-56 flex-col border-l border-base-300 flex-shrink-0 sticky top-0 self-start max-h-[calc(100vh-6rem)]">
			{/* View Controls Section */}
			<div className="p-4 border-b border-base-300">
				<h3 className="font-semibold text-sm uppercase tracking-wide mb-4 text-base-content/70">
					View Controls
				</h3>

				{/* Navigation */}
				<div className="space-y-2 mb-4">
					<span className="text-xs text-base-content/50 uppercase tracking-wide">Navigation</span>

					<div className="flex gap-1">
						{previousPage ? (
							<button
								type="button"
								onClick={() => onNavigate(previousPage.section, previousPage.file)}
								className="btn btn-ghost btn-sm flex-1 justify-start gap-1"
								title={previousPage.name}
							>
								<ChevronLeftIcon className="h-4 w-4 flex-shrink-0" />
								<span className="truncate text-xs">Prev</span>
							</button>
						) : (
							<button
								type="button"
								className="btn btn-ghost btn-sm flex-1 justify-start gap-1 opacity-30 cursor-not-allowed"
								disabled
							>
								<ChevronLeftIcon className="h-4 w-4 flex-shrink-0" />
								<span className="truncate text-xs">Prev</span>
							</button>
						)}

						{nextPage ? (
							<button
								type="button"
								onClick={() => onNavigate(nextPage.section, nextPage.file)}
								className="btn btn-ghost btn-sm flex-1 justify-start gap-1"
								title={nextPage.name}
							>
								<span className="truncate text-xs">Next</span>
								<ChevronRightIcon className="h-4 w-4 flex-shrink-0" />
							</button>
						) : (
							<button
								type="button"
								className="btn btn-ghost btn-sm flex-1 justify-start gap-1 opacity-30 cursor-not-allowed"
								disabled
							>
								<span className="truncate text-xs">Next</span>
								<ChevronRightIcon className="h-4 w-4 flex-shrink-0" />
							</button>
						)}
					</div>
				</div>

				{/* Zoom */}
				<div className="space-y-2">
					<span className="text-xs text-base-content/50 uppercase tracking-wide">Zoom</span>

					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={handleZoomOut}
							className="btn btn-ghost btn-xs btn-square"
							disabled={zoomLevel <= ZOOM_MIN}
							title="Zoom out"
						>
							<MagnifyingGlassMinusIcon className="h-4 w-4" />
						</button>

						<button
							type="button"
							onClick={handleZoomReset}
							className="btn btn-ghost btn-xs flex-1 text-xs"
							title="Reset zoom to 100%"
						>
							{Math.round(zoomLevel * 100)}%
						</button>

						<button
							type="button"
							onClick={handleZoomIn}
							className="btn btn-ghost btn-xs btn-square"
							disabled={zoomLevel >= ZOOM_MAX}
							title="Zoom in"
						>
							<MagnifyingGlassPlusIcon className="h-4 w-4" />
						</button>
					</div>

					<input
						type="range"
						min={ZOOM_MIN * 100}
						max={ZOOM_MAX * 100}
						value={zoomLevel * 100}
						onChange={(e) => onZoomChange(Number(e.target.value) / 100)}
						className="range range-xs range-primary w-full"
						step={ZOOM_STEP * 100}
					/>
				</div>
			</div>

			{/* Table of Contents Section */}
			{headings.length > 0 && (
				<div className="flex-1 overflow-y-auto p-4">
					<div className="flex items-center gap-2 mb-4">
						<ListBulletIcon className="h-5 w-5 text-primary" />
						<h3 className="font-semibold text-sm uppercase tracking-wide">On This Page</h3>
					</div>
					<nav className="space-y-1">
						{headings.map((heading) => (
							<button
								type="button"
								key={heading.id}
								onClick={() => scrollToHeading(heading.id)}
								className={`block w-full text-left text-sm py-1.5 px-2 rounded transition-colors ${
									heading.level === 3 ? "pl-5" : "pl-2"
								} ${
									activeId === heading.id
										? "bg-primary/20 text-primary font-medium border-l-2 border-primary"
										: "text-base-content/70 hover:text-base-content hover:bg-base-200"
								}`}
							>
								{heading.text}
							</button>
						))}
					</nav>
				</div>
			)}
		</aside>
	);
}
