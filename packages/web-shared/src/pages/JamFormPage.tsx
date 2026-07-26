// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import FileUpload from "../components/ui/FileUpload";
import FormField from "../components/ui/FormField";
import { apiFetch, client } from "../lib/rpc";
import type { GameJam } from "../lib/types";

function toLocalDatetime(isoStr: string): string {
	if (!isoStr) return "";
	const d = new Date(isoStr);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function JamFormPage() {
	const navigate = useNavigate();
	const { slug } = useParams<{ slug: string }>();
	const isEditing = !!slug;

	const [title, setTitle] = useState("");
	const [jamSlug, setJamSlug] = useState("");
	const [description, setDescription] = useState("");
	const [theme, setTheme] = useState("");
	const [startAt, setStartAt] = useState("");
	const [endAt, setEndAt] = useState("");
	const [votingEndAt, setVotingEndAt] = useState("");
	const [maxTeamSize, setMaxTeamSize] = useState(0);
	const [allowLate, setAllowLate] = useState(false);

	const [coverFile, setCoverFile] = useState<File | null>(null);
	const [coverPreview, setCoverPreview] = useState<string | null>(null);

	const [saving, setSaving] = useState(false);
	const [loading, setLoading] = useState(isEditing);
	const [error, setError] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});

	useEffect(() => {
		if (!slug) return;
		client.api.jams[":slug"]
			.$get({ param: { slug } })
			.then((res) => res.json() as Promise<unknown>)
			.then((data: unknown) => {
				const jam = (data as { jam: GameJam }).jam;
				setTitle(jam.title);
				setJamSlug(jam.slug);
				setDescription(jam.description || "");
				setTheme(jam.theme || "");
				setStartAt(toLocalDatetime(jam.startAt));
				setEndAt(toLocalDatetime(jam.endAt));
				setVotingEndAt(toLocalDatetime(jam.votingEndAt));
				setMaxTeamSize(jam.maxTeamSize ?? 0);
				setAllowLate(jam.allowLateSubmissions ?? false);
				if (jam.coverImage) setCoverPreview(jam.coverImage);
			})
			.catch(() => setError("Failed to load jam."))
			.finally(() => setLoading(false));
	}, [slug]);

	const generateSlug = (t: string) => {
		return t
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.slice(0, 255);
	};

	const handleTitleChange = (t: string) => {
		setTitle(t);
		if (!isEditing) {
			setJamSlug(generateSlug(t));
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		setErrors({});

		try {
			const formData = new FormData();
			formData.append("title", title);
			formData.append("slug", jamSlug);
			formData.append("description", description);
			formData.append("theme", theme);
			formData.append("startAt", new Date(startAt).toISOString());
			formData.append("endAt", new Date(endAt).toISOString());
			formData.append("votingEndAt", new Date(votingEndAt).toISOString());
			formData.append("maxTeamSize", maxTeamSize.toString());
			formData.append("allowLateSubmissions", allowLate.toString());
			if (coverFile) formData.append("coverImage", coverFile);

			if (isEditing) {
				const res = await apiFetch(`/api/jams/${slug}`, {
					method: "PATCH",
					body: formData,
				});
				if (!res.ok) throw res;
				navigate(`/jams/${jamSlug}`);
			} else {
				const res = await apiFetch("/api/jams", {
					method: "POST",
					body: formData,
				});
				if (!res.ok) throw res;
				const result = (await res.json()) as { jam: GameJam };
				navigate(`/jams/${result.jam.slug}`);
			}
		} catch (err) {
			if (err instanceof Response) {
				try {
					const data = await err.json();
					if (data && typeof data === "object") {
						const fieldErrors: Record<string, string> = {};
						for (const [key, val] of Object.entries(data as Record<string, string[]>)) {
							fieldErrors[key] = Array.isArray(val) ? val[0] : String(val);
						}
						setErrors(fieldErrors);
						return;
					}
				} catch {
					// Fall through
				}
			}
			setError("Failed to save jam.");
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<span className="loading loading-spinner loading-lg" />
			</div>
		);
	}

	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-6">{isEditing ? "Edit Jam" : "Host a Game Jam"}</h1>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}

			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				<FormField label="Title" error={errors.title}>
					<input
						type="text"
						className="input input-bordered w-full"
						value={title}
						onChange={(e) => handleTitleChange(e.target.value)}
						required
					/>
				</FormField>

				<FormField label="Slug" error={errors.slug}>
					<input
						type="text"
						className="input input-bordered w-full"
						value={jamSlug}
						onChange={(e) => setJamSlug(e.target.value)}
						required
					/>
				</FormField>

				<FormField label="Description" error={errors.description}>
					<textarea
						className="textarea textarea-bordered w-full"
						rows={4}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="Rules, guidelines, and what you're looking for..."
					/>
				</FormField>

				<FormField label="Theme" error={errors.theme}>
					<input
						type="text"
						className="input input-bordered w-full"
						value={theme}
						onChange={(e) => setTheme(e.target.value)}
						placeholder="Hidden until the jam starts"
					/>
					<p className="text-xs text-base-content/40 mt-1">
						The theme is hidden from participants until the jam starts.
					</p>
				</FormField>

				<FormField label="Cover Image" error={errors.coverImage}>
					<FileUpload
						accept="image/*"
						maxSize={10 * 1024 * 1024}
						preview={coverPreview}
						label="Upload cover image"
						onFileSelect={(file) => {
							setCoverFile(file);
							setCoverPreview(URL.createObjectURL(file));
						}}
						onClear={() => {
							setCoverFile(null);
							setCoverPreview(null);
						}}
					/>
				</FormField>

				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					<FormField label="Starts at" error={errors.startAt}>
						<input
							type="datetime-local"
							className="input input-bordered w-full"
							value={startAt}
							onChange={(e) => setStartAt(e.target.value)}
							required
						/>
					</FormField>

					<FormField label="Ends at" error={errors.endAt}>
						<input
							type="datetime-local"
							className="input input-bordered w-full"
							value={endAt}
							onChange={(e) => setEndAt(e.target.value)}
							required
						/>
					</FormField>

					<FormField label="Voting ends at" error={errors.votingEndAt}>
						<input
							type="datetime-local"
							className="input input-bordered w-full"
							value={votingEndAt}
							onChange={(e) => setVotingEndAt(e.target.value)}
							required
						/>
					</FormField>
				</div>

				<FormField label="Max Team Size" error={errors.maxTeamSize}>
					<input
						type="number"
						className="input input-bordered w-full"
						value={maxTeamSize}
						onChange={(e) => setMaxTeamSize(parseInt(e.target.value, 10) || 0)}
						min={0}
					/>
					<p className="text-xs text-base-content/40 mt-1">0 = unlimited</p>
				</FormField>

				<div className="form-control">
					<label className="label cursor-pointer justify-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-primary"
							checked={allowLate}
							onChange={(e) => setAllowLate(e.target.checked)}
						/>
						<div>
							<span className="label-text font-medium">Allow late submissions</span>
							<p className="text-xs text-base-content/50 mt-0.5">
								Allow entries after the jam end date
							</p>
						</div>
					</label>
				</div>

				<div className="mt-2">
					<button
						type="submit"
						className={`btn btn-primary ${saving ? "btn-disabled" : ""}`}
						disabled={saving}
					>
						{saving ? "Saving..." : isEditing ? "Update Jam" : "Create Jam"}
					</button>
				</div>
			</form>
		</div>
	);
}
