// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ArrowDownTrayIcon,
	CheckCircleIcon,
	ExclamationCircleIcon,
	MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

interface ItchioGame {
	url: string;
	title: string;
	coverImage: string;
	shortDescription: string;
}

interface ImportResult {
	url: string;
	status: "imported" | "failed";
	projectId?: number;
	projectSlug?: string;
	title?: string;
	error?: string;
}

export default function ImportPage() {
	const [username, setUsername] = useState("");
	const [games, setGames] = useState<ItchioGame[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(false);
	const [importing, setImporting] = useState(false);
	const [results, setResults] = useState<ImportResult[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const handleSearch = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!username.trim()) return;

		setLoading(true);
		setError(null);
		setGames([]);
		setResults(null);
		setSelected(new Set());

		try {
			const res = await fetch(
				`${apiBase}/api/integrations/import/itchio/preview?username=${encodeURIComponent(username.trim())}`,
				{ credentials: "include" },
			);
			if (!res.ok) {
				const errData = await res.json().catch(() => ({}));
				throw new Error((errData as { detail?: string })?.detail ?? "Failed to fetch games.");
			}
			const data = (await res.json()) as { username: string; games: ItchioGame[] };
			setGames(data.games);
			// Select all by default
			setSelected(new Set(data.games.map((g) => g.url)));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setLoading(false);
		}
	};

	const toggleGame = (url: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(url)) {
				next.delete(url);
			} else {
				next.add(url);
			}
			return next;
		});
	};

	const toggleAll = () => {
		if (selected.size === games.length) {
			setSelected(new Set());
		} else {
			setSelected(new Set(games.map((g) => g.url)));
		}
	};

	const handleImport = async () => {
		if (selected.size === 0) return;

		setImporting(true);
		setError(null);

		const gamesToImport = games.filter((g) => selected.has(g.url)).map((g) => ({ url: g.url }));

		try {
			const res = await client.api.integrations.import.itchio.$post({
				json: { games: gamesToImport },
			});
			const data = (await res.json()) as unknown as {
				imported: number;
				total: number;
				results: ImportResult[];
			};
			setResults(data.results);
		} catch (err) {
			if (err instanceof Response) {
				try {
					const data = (await err.json()) as { detail?: string };
					setError(data?.detail ?? "Import failed.");
				} catch {
					setError("Something went wrong during import.");
				}
			} else {
				setError("Something went wrong during import.");
			}
		} finally {
			setImporting(false);
		}
	};

	const importedCount = results?.filter((r) => r.status === "imported").length ?? 0;

	return (
		<div className="container mx-auto px-4 py-8 max-w-3xl">
			<h1 className="text-3xl font-bold mb-2">Import from itch.io</h1>
			<p className="text-base-content/60 mb-6">
				Enter your itch.io username to find your public games and import them as draft projects on
				Anthers.
			</p>

			{/* Search form */}
			<form onSubmit={handleSearch} className="flex gap-2 mb-6">
				<input
					type="text"
					placeholder="itch.io username"
					className="input input-bordered flex-1"
					value={username}
					onChange={(e) => setUsername(e.target.value)}
					disabled={loading || importing}
				/>
				<button
					type="submit"
					className="btn btn-primary"
					disabled={loading || importing || !username.trim()}
				>
					{loading ? <LoadingSpinner size="sm" /> : <MagnifyingGlassIcon className="w-5 h-5" />}
					Search
				</button>
			</form>

			{error && (
				<div className="alert alert-error mb-6">
					<ExclamationCircleIcon className="w-5 h-5" />
					<span>{error}</span>
				</div>
			)}

			{/* Results after import */}
			{results && (
				<div className="mb-8">
					<div className="alert alert-success mb-4">
						<CheckCircleIcon className="w-5 h-5" />
						<span>
							Imported {importedCount} of {results.length} games as draft projects.
						</span>
					</div>
					<div className="space-y-2">
						{results.map((r) => (
							<div
								key={r.url}
								className={`flex items-center justify-between p-3 rounded-lg ${
									r.status === "imported" ? "bg-success/10" : "bg-error/10"
								}`}
							>
								<div>
									<span className="font-medium text-sm">{r.title || r.url}</span>
									{r.error && <p className="text-xs text-error">{r.error}</p>}
								</div>
								{r.status === "imported" && r.projectSlug && (
									<Link to={`/projects/${r.projectSlug}/edit`} className="btn btn-sm btn-outline">
										Edit Draft
									</Link>
								)}
							</div>
						))}
					</div>
					<div className="mt-4">
						<Link to="/" className="btn btn-primary">
							Go to Dashboard
						</Link>
					</div>
				</div>
			)}

			{/* Game list */}
			{games.length > 0 && !results && (
				<>
					<div className="flex items-center justify-between mb-4">
						<h2 className="text-lg font-semibold">
							Found {games.length} {games.length === 1 ? "game" : "games"}
						</h2>
						<div className="flex items-center gap-3">
							<label className="label cursor-pointer gap-2">
								<input
									type="checkbox"
									className="checkbox checkbox-sm"
									checked={selected.size === games.length}
									onChange={toggleAll}
								/>
								<span className="label-text text-sm">Select all</span>
							</label>
							<button
								type="button"
								className="btn btn-primary btn-sm"
								disabled={selected.size === 0 || importing}
								onClick={handleImport}
							>
								{importing ? (
									<>
										<LoadingSpinner size="sm" />
										Importing...
									</>
								) : (
									<>
										<ArrowDownTrayIcon className="w-4 h-4" />
										Import {selected.size} selected
									</>
								)}
							</button>
						</div>
					</div>

					<div className="space-y-3">
						{games.map((game) => (
							<label
								key={game.url}
								className={`flex items-center gap-4 p-3 rounded-lg border cursor-pointer transition-colors ${
									selected.has(game.url)
										? "border-primary bg-primary/5"
										: "border-base-300 hover:border-base-content/20"
								}`}
							>
								<input
									type="checkbox"
									className="checkbox checkbox-sm checkbox-primary"
									checked={selected.has(game.url)}
									onChange={() => toggleGame(game.url)}
								/>
								{game.coverImage && (
									<img
										src={game.coverImage}
										alt={game.title}
										className="w-16 h-12 object-cover rounded"
									/>
								)}
								<div className="flex-1 min-w-0">
									<div className="font-medium text-sm truncate">{game.title}</div>
									{game.shortDescription && (
										<p className="text-xs text-base-content/50 line-clamp-1">
											{game.shortDescription}
										</p>
									)}
								</div>
							</label>
						))}
					</div>
				</>
			)}

			{/* Empty state after search */}
			{!loading && games.length === 0 && !error && !results && username && (
				<EmptyState
					title="No games found"
					description="Make sure you entered the correct itch.io username."
				/>
			)}
		</div>
	);
}
