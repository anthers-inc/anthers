// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link, useNavigate } from "@anthers/web-shared/router";
import type { Project } from "@anthers/web-shared/types";
import {
	ArrowRightIcon,
	MagnifyingGlassIcon,
	RectangleStackIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE =
	typeof location !== "undefined" &&
	(location.hostname === "localhost" || location.hostname === "127.0.0.1")
		? "http://localhost:8000"
		: "";

export default function SearchBar() {
	const navigate = useNavigate();
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	const [focused, setFocused] = useState(false);
	const [results, setResults] = useState<Project[]>([]);
	const [loading, setLoading] = useState(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const panelOpen = focused && query.length > 0;

	// Ctrl+K / Cmd+K shortcut
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "k") {
				e.preventDefault();
				inputRef.current?.focus();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, []);

	// Click outside to close
	useEffect(() => {
		if (!panelOpen) return;
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setFocused(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [panelOpen]);

	// Debounced search
	const search = useCallback((term: string) => {
		if (debounceRef.current) clearTimeout(debounceRef.current);

		if (!term.trim()) {
			setResults([]);
			setLoading(false);
			return;
		}

		setLoading(true);
		debounceRef.current = setTimeout(() => {
			const params = new URLSearchParams({ search: term.trim() });
			fetch(`${API_BASE}/api/content/projects?${params.toString()}`, {
				credentials: "include",
			})
				.then((res) => res.json())
				.then((json) => setResults((json.projects as Project[]).slice(0, 6)))
				.catch(() => setResults([]))
				.finally(() => setLoading(false));
		}, 250);
	}, []);

	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = e.target.value;
		setQuery(val);
		search(val);
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!query.trim()) return;
		setFocused(false);
		navigate(`/discover?search=${encodeURIComponent(query.trim())}`);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			setFocused(false);
			inputRef.current?.blur();
		}
	};

	const close = () => {
		setQuery("");
		setResults([]);
		setFocused(false);
	};

	return (
		<div ref={containerRef} className="relative w-[min(45vw,640px)]">
			<form onSubmit={handleSubmit} className="relative">
				<MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-base-content/40 pointer-events-none" />
				<input
					ref={inputRef}
					type="text"
					placeholder="Search..."
					className="input input-sm w-full pl-9 pr-16 border-none bg-base-300/40 shadow-inner focus:bg-base-300/60 focus:outline-none"
					value={query}
					onChange={handleChange}
					onFocus={() => setFocused(true)}
					onKeyDown={handleKeyDown}
				/>
				<div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
					{query && (
						<button
							type="button"
							className="btn btn-ghost btn-xs btn-circle"
							onClick={close}
							aria-label="Clear search"
						>
							<XMarkIcon className="w-3.5 h-3.5" />
						</button>
					)}
					{!query && <kbd className="kbd kbd-xs text-base-content/30">Ctrl K</kbd>}
				</div>
			</form>

			{/* Results panel */}
			{panelOpen && (
				<div className="absolute top-full left-0 right-0 mt-1 bg-base-200 rounded-lg shadow-xl border border-base-300/50 overflow-hidden z-50">
					{loading && results.length === 0 ? (
						<div className="px-4 py-6 text-center">
							<span className="loading loading-spinner loading-sm text-base-content/40" />
						</div>
					) : results.length > 0 ? (
						<div>
							<div className="px-3 py-2 text-xs font-semibold text-base-content/40 uppercase tracking-wider">
								Projects
							</div>
							<ul className="menu menu-sm p-0">
								{results.map((project) => {
									const Icon = RectangleStackIcon;
									return (
										<li key={project.id}>
											<Link
												to={`/${project.creator?.username ?? "unknown"}/${project.slug}`}
												className="flex items-center gap-3 px-3 py-2"
												onClick={() => {
													setFocused(false);
													setQuery("");
												}}
											>
												{project.coverImage ? (
													<img
														src={project.coverImage}
														alt=""
														className="w-8 h-8 rounded object-cover shrink-0"
													/>
												) : (
													<div className="w-8 h-8 rounded bg-base-300 flex items-center justify-center shrink-0">
														<Icon className="w-4 h-4 text-base-content/30" />
													</div>
												)}
												<div className="flex-1 min-w-0">
													<p className="text-sm font-medium truncate">{project.title}</p>
													{project.creator && (
														<p className="text-xs text-base-content/50 truncate">
															{project.creator.displayName || project.creator.username}
														</p>
													)}
												</div>
												<Icon className="w-4 h-4 text-base-content/30 shrink-0" />
											</Link>
										</li>
									);
								})}
							</ul>
							<div className="border-t border-base-300/50">
								<Link
									to={`/discover?search=${encodeURIComponent(query.trim())}`}
									className="flex items-center gap-2 px-3 py-2.5 text-xs text-primary hover:bg-base-300/30 transition-colors"
									onClick={() => {
										setFocused(false);
										setQuery("");
									}}
								>
									<ArrowRightIcon className="w-3.5 h-3.5" />
									View all results for &ldquo;{query.trim()}&rdquo;
								</Link>
							</div>
						</div>
					) : (
						<div className="px-4 py-6 text-center text-sm text-base-content/50">
							No results for &ldquo;{query.trim()}&rdquo;
						</div>
					)}
				</div>
			)}
		</div>
	);
}
