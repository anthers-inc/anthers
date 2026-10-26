// SPDX-License-Identifier: Apache-2.0
/**
 * A **Project's editing surface, on the Project's own page** — the pattern Parker set in
 * motion on the Work page (`OwnerWorkEditor`) and extended to Projects 2026-10-17: the
 * creator and any user see the SAME page, and the creator's edit controls live inline in
 * the very places the user sees the result.
 *
 * ⭐ **The Studio ends at the Projects list.** Editing one Project happens on its page,
 * which is a place users can see; what a user never sees is the studio edit route, which
 * folds away to a redirect, and the editable shelves below — working lists, the same
 * exemption a Work's Manage tab carries.
 *
 * Every editable thing is an `InlineField` — pencil opens it, X cancels, checkmark saves
 * the field alone; there is no page-wide Save. The one deliberate exception is the
 * thumbnail, which acts on its read state (upload and remove are the acts a Work page's
 * thumbnail field carries; there is no pencil and no separate edit state to save).
 *
 * ⚠️ **Saves are narrow, one field per request, and adopt the response.** The server's
 * own rules answer in their own words — the publish refusal most of all — and a field's
 * error shows where the field lives. The thumbnail's change is checked server-side against
 * the creator's own storage prefix, as every stored file reference is.
 */

import type { ImageCrop } from "@anthers/shared/image-frame";
import ProjectPosts from "@anthers/web-shared/content/ProjectPosts";
import ProjectWorks from "@anthers/web-shared/content/ProjectWorks";
import { RecordLinkButton } from "@anthers/web-shared/content/RecordLink";
import { usePayoutsReady } from "@anthers/web-shared/payouts";
import {
	frameImageFile,
	keyToPreview,
	uploadImageFile,
} from "@anthers/web-shared/post/mediaUpload";
import { publishingPermissionMissing, usePublishingState } from "@anthers/web-shared/publishing";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { studioUrl } from "@anthers/web-shared/studio";
import type { Project } from "@anthers/web-shared/types";
import ImageEditMenu from "@anthers/web-shared/ui/ImageEditMenu";
import ImageFrameModal from "@anthers/web-shared/ui/ImageFrameModal";
import { PhotoIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { InlineField } from "../work/Editing";
import { WorkViewAsRow } from "../work/ViewAs";

export default function OwnerProjectEditor({
	project,
	onAdopt,
}: {
	project: Project;
	/** A field save's answer is the row the page now shows; the page merges it in. */
	onAdopt: (row: Omit<Project, "works" | "posts" | "creator">) => void;
}) {
	// The thumbnail, as the row holds it — the read state the upload, the Work choice and the
	// remove act write. `thumbnailWorkId` names the Work when the thumbnail is one of the
	// Project's own; the server has already resolved `thumbnail` to that Work's thumbnail.
	const [thumbnail, setThumbnail] = useState(project.thumbnail ?? "");
	/** The full upload the image was framed from, kept so a reposition can zoom back out. */
	const [thumbnailSource, setThumbnailSource] = useState(project.thumbnailSource ?? "");
	/** The window it was last framed at, so the dialog reopens there. */
	const [thumbnailCrop, setThumbnailCrop] = useState(project.thumbnailCrop ?? null);
	const [thumbnailWorkId, setThumbnailWorkId] = useState<number | null>(
		project.thumbnailWorkId ?? null,
	);
	const [thumbnailError, setThumbnailError] = useState<string | null>(null);
	const [thumbnailBusy, setThumbnailBusy] = useState(false);
	const [thumbnailPickerOpen, setThumbnailPickerOpen] = useState(false);
	const [framing, setFraming] = useState<{
		preview: string;
		file: File | null;
		source: string | null;
	} | null>(null);
	const thumbnailInput = useRef<HTMLInputElement>(null);

	const payoutsReady = usePayoutsReady();
	const publishing = usePublishingState();
	const permissionMissing = publishingPermissionMissing(publishing);

	type ProjectRow = Omit<Project, "works" | "posts" | "creator">;

	const patchFields = async (fields: {
		title?: string;
		description?: string;
		thumbnail?: string;
		thumbnailSource?: string;
		thumbnailCrop?: ImageCrop | null;
		thumbnailWorkId?: number | null;
		isPublished?: boolean;
	}): Promise<ProjectRow> => {
		const res = await client.api.content.projects[":slug"].$patch({
			param: { slug: project.slug },
			json: fields,
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(body?.error ?? "Failed to save this Project.");
		}
		const { project: updated } = await res.json();
		onAdopt(updated);
		return updated;
	};

	const saveFields = async (fields: {
		title?: string;
		description?: string;
		thumbnail?: string;
		thumbnailSource?: string;
		isPublished?: boolean;
	}): Promise<void> => {
		await patchFields(fields);
	};

	// The image acts on its read state: a framed save is the edit, and remove saves empty.
	const closeFraming = () => {
		if (framing?.file) URL.revokeObjectURL(framing.preview);
		setFraming(null);
	};

	const pickedThumbnail = (file: File) => {
		setThumbnailError(null);
		setFraming({ preview: URL.createObjectURL(file), file, source: null });
	};

	const startReposition = () => {
		// A row written before the source column falls back to the image already stored.
		const source = keyToPreview(thumbnailSource || thumbnail);
		if (!source) return;
		setThumbnailError(null);
		setFraming({ preview: source, file: null, source });
	};

	const saveFramedThumbnail = async (crop: {
		x: number;
		y: number;
		width: number;
		height: number;
	}) => {
		if (!framing) return;
		setThumbnailError(null);
		setThumbnailBusy(true);
		try {
			const source = framing.file
				? (await uploadImageFile(framing.file, "thumbnail")).url
				: framing.source;
			if (!source) throw new Error("That image isn't available any more. Upload it again.");
			const framed = await frameImageFile(source, "thumbnail", crop);
			// A framed upload is the other way to choose an image, so it retires any Work
			// reference in the same act.
			const updated = await patchFields({
				thumbnail: framed.url,
				thumbnailSource: source,
				thumbnailCrop: crop,
				thumbnailWorkId: null,
			});
			setThumbnail(updated.thumbnail ?? "");
			setThumbnailSource(updated.thumbnailSource ?? "");
			setThumbnailCrop(updated.thumbnailCrop ?? null);
			setThumbnailWorkId(updated.thumbnailWorkId ?? null);
			closeFraming();
		} catch (err) {
			setThumbnailError(
				err instanceof Error ? err.message : "The image didn't save. Try it again.",
			);
		} finally {
			setThumbnailBusy(false);
		}
	};

	// Choosing one of the Project's Works asks the server for that Work's own thumbnail; the
	// answer is the row the page now shows, so the preview follows in the same act.
	const chooseThumbnailWork = async (workId: number) => {
		setThumbnailError(null);
		setThumbnailBusy(true);
		try {
			const updated = await patchFields({ thumbnailWorkId: workId });
			setThumbnail(updated.thumbnail ?? "");
			setThumbnailSource(updated.thumbnailSource ?? "");
			setThumbnailCrop(updated.thumbnailCrop ?? null);
			setThumbnailWorkId(updated.thumbnailWorkId ?? null);
			setThumbnailPickerOpen(false);
		} catch (err) {
			setThumbnailError(
				err instanceof Error ? err.message : "That Work's thumbnail didn't save. Try again.",
			);
		} finally {
			setThumbnailBusy(false);
		}
	};

	// Published, as the row holds it — the toggle's disabled state reads the SAVED value,
	// because the gates are on the transition into published, never on editing what is one.
	const isPublished = project.isPublished === true;
	const publishBlocked = !isPublished && (payoutsReady === false || permissionMissing === true);

	const removeThumbnail = async () => {
		setThumbnailError(null);
		setThumbnailBusy(true);
		try {
			// Removing the thumbnail clears both choices: the uploaded image and any Work it
			// was borrowing from.
			const updated = await patchFields({
				thumbnail: "",
				thumbnailSource: "",
				thumbnailCrop: null,
				thumbnailWorkId: null,
			});
			setThumbnail(updated.thumbnail ?? "");
			setThumbnailSource(updated.thumbnailSource ?? "");
			setThumbnailCrop(updated.thumbnailCrop ?? null);
			setThumbnailWorkId(updated.thumbnailWorkId ?? null);
		} catch (err) {
			setThumbnailError(
				err instanceof Error ? err.message : "Couldn't remove the thumbnail just now.",
			);
		} finally {
			setThumbnailBusy(false);
		}
	};

	const thumbnailWork = (project.works ?? []).find((work) => work.id === thumbnailWorkId);

	return (
		<div className="container mx-auto px-4 py-8 max-w-5xl">
			{/* The View As row stands where the Studio route's redirect left the creator: the
			    page itself is the edit surface, and the modes are the ways to look at it. */}
			<div className="mb-4 flex flex-col gap-2">
				<h3 className="text-xs font-medium uppercase tracking-wide text-base-content/40">
					View As
				</h3>
				<WorkViewAsRow subject="Project" />
			</div>

			{/* The thumbnail — the user's hero, with the acts on it. The blank frame holds the
			    page's shape while no thumbnail exists, as the Work page's own does. */}
			{thumbnail ? (
				<div className="mx-auto w-full max-w-3xl aspect-video overflow-hidden rounded-lg mb-6">
					<img src={thumbnail} alt={project.title} className="w-full h-full object-cover" />
				</div>
			) : (
				<div
					aria-hidden="true"
					className="mx-auto mb-6 flex aspect-video w-full max-w-3xl items-center justify-center rounded-lg border border-dashed border-base-content/25 bg-base-200/30 text-base-content/25"
				>
					<PhotoIcon className="h-8 w-8" />
				</div>
			)}
			<div className="mb-6 flex flex-col gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<input
						ref={thumbnailInput}
						type="file"
						accept="image/*"
						className="hidden"
						onChange={(e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (file) pickedThumbnail(file);
						}}
					/>
					<ImageEditMenu
						label="thumbnail"
						triggerLabel="Edit Thumbnail"
						hasImage={Boolean(thumbnail) && thumbnailWorkId == null}
						busy={thumbnailBusy}
						onUpload={() => {
							setThumbnailError(null);
							thumbnailInput.current?.click();
						}}
						onReposition={startReposition}
						repositionDisabledReason={
							thumbnailWorkId != null ? "Reposition it on the Work it comes from." : undefined
						}
						extra={{
							label: "Choose from Work",
							onSelect: () => {
								setThumbnailError(null);
								setThumbnailPickerOpen(true);
							},
						}}
					/>
					{(thumbnail || thumbnailWorkId != null) && (
						<button
							type="button"
							className="btn btn-ghost btn-sm text-error"
							disabled={thumbnailBusy}
							onClick={() => void removeThumbnail()}
						>
							Remove
						</button>
					)}
				</div>
				{thumbnailWork && (
					<p className="text-xs text-base-content/60">
						Using the thumbnail from <span className="font-medium">{thumbnailWork.title}</span>.
					</p>
				)}
				{thumbnailError && <p className="text-xs text-error">{thumbnailError}</p>}
			</div>

			{/* Title — centered read like the public page's h1, pencil beside it. */}
			<div className="mb-2 flex flex-col gap-1">
				<InlineField<string>
					label="Title"
					saved={project.title}
					renderRead={() => <h1 className="text-3xl font-bold">{project.title}</h1>}
					renderEdit={(draft, setDraft) => (
						<input
							type="text"
							aria-label="Title"
							className="input input-bordered w-full text-xl"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
						/>
					)}
					save={(draft) => {
						const trimmed = draft.trim();
						if (!trimmed) throw new Error("A Project needs a title.");
						return saveFields({ title: trimmed });
					}}
				/>
				{project.creator && (
					<p className="text-sm text-base-content/70">
						by {project.creator.displayName || project.creator.handle}
					</p>
				)}
			</div>

			{/* The description — its own pencil, the user's version rendered. An empty field
			    says it is here. */}
			<div className="mb-4 flex flex-col gap-3">
				<InlineField<string>
					label="Description"
					saved={project.description ?? ""}
					renderRead={() =>
						project.description ? (
							<div className="prose prose-sm max-w-none">
								<Markdown remarkPlugins={[remarkGfm]}>{project.description}</Markdown>
							</div>
						) : (
							<p className="text-sm text-base-content/40">No description yet.</p>
						)
					}
					renderEdit={(draft, setDraft) => (
						<textarea
							aria-label="Description"
							className="textarea textarea-bordered w-full min-h-[150px]"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							placeholder="Full description of this project (Markdown supported)"
						/>
					)}
					save={(draft) => saveFields({ description: draft.trim() })}
				/>
			</div>

			{/* The project's listing on the network — the same record link the hero carried,
			    placed after the fields so the editing form reads in one column. */}
			<div className="mb-6">
				<RecordLinkButton recordUrl={project.recordUrl} />
			</div>

			{/* Publish, as the release field is for a Work: the read of what is stored, the
			    toggle behind the pencil, and the server's refusals said in place. */}
			<div className="mb-8">
				<InlineField
					label="Publish"
					saved={isPublished}
					renderRead={() => (
						<p className="text-sm">
							{isPublished
								? "Published — this Project is visible to everyone."
								: "Unpublished — a draft only you can read."}
						</p>
					)}
					renderEdit={(draft, setDraft) => (
						<div className="flex flex-col gap-2">
							<label className="label cursor-pointer justify-start gap-3">
								<input
									type="checkbox"
									aria-label="Publish this Project"
									className="toggle toggle-primary"
									checked={Boolean(draft)}
									disabled={publishBlocked}
									onChange={(e) => setDraft(e.target.checked)}
								/>
								<span className="label-text text-sm font-medium">Published</span>
							</label>
							{permissionMissing === true && (
								<p className="text-xs text-warning">
									Give Anthers permission to publish in{" "}
									<Link to={studioUrl("/settings")} className="link">
										Studio settings
									</Link>{" "}
									before publishing, since a project is written into your own repository. You can
									keep building the project as a draft until then.
								</p>
							)}
							{payoutsReady === false && (
								<p className="text-xs text-warning">
									Set up payouts in{" "}
									<Link to={studioUrl("/payments")} className="link">
										the Studio's Payments tab
									</Link>{" "}
									before publishing. You can keep building the project as a draft until then.
								</p>
							)}
							<p className="text-xs text-base-content/50">
								Published projects are visible to everyone
							</p>
						</div>
					)}
					save={(draft) => saveFields({ isPublished: Boolean(draft) })}
				/>
			</div>

			{/* The two lists — the working lists on the creator's copy of the page. A post's
			    member list says the same in fewer words; the Works list's docblock
			    carries the persist-per-act ruling. */}
			<div className="mb-8">
				<h2 className="font-semibold text-sm mb-1">Works</h2>
				<p className="text-xs text-base-content/50 mb-3">
					The Works on this Project, in order. Putting one here changes nothing about who can open
					it.
				</p>
				<ProjectWorks projectSlug={project.slug} />
			</div>

			<div className="mb-8">
				<h2 className="font-semibold text-sm mb-1">Posts</h2>
				<p className="text-xs text-base-content/50 mb-3">
					The posts about this Project, in order — its devlogs, patch notes and announcements.
				</p>
				<ProjectPosts projectSlug={project.slug} />
			</div>

			<ImageFrameModal
				open={framing !== null}
				src={framing?.preview ?? null}
				mediaType="thumbnail"
				busy={thumbnailBusy}
				error={thumbnailError}
				initialCrop={framing?.file ? null : thumbnailCrop}
				onCancel={closeFraming}
				onSave={(crop) => void saveFramedThumbnail(crop)}
			/>

			{thumbnailPickerOpen && (
				<ThumbnailWorkPicker
					works={project.works ?? []}
					selectedId={thumbnailWorkId}
					busy={thumbnailBusy}
					onChoose={(workId) => void chooseThumbnailWork(workId)}
					onClose={() => setThumbnailPickerOpen(false)}
				/>
			)}
		</div>
	);
}

/**
 * The Project's thumbnail, chosen from one of its Works.
 *
 * ⭐ **The choice is the Work, not a copy of its picture** — the Project wears whatever
 * thumbnail that Work has, now and after the creator changes it. So the tile shows the
 * Work's current thumbnail, and a Work without one cannot dress the Project yet: its tile
 * says so rather than standing in as a blank choice.
 */
function ThumbnailWorkPicker({
	works,
	selectedId,
	busy,
	onChoose,
	onClose,
}: {
	works: Project["works"];
	selectedId: number | null;
	busy: boolean;
	onChoose: (workId: number) => void;
	onClose: () => void;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="modal modal-open" role="dialog" aria-label="Thumbnail from a Work">
			<div className="modal-box max-w-2xl">
				<button
					type="button"
					className="btn btn-ghost btn-sm btn-circle absolute right-2 top-2"
					aria-label="Close"
					onClick={onClose}
				>
					<XMarkIcon className="h-4 w-4" />
				</button>
				<h3 className="text-lg font-semibold">Thumbnail from a Work</h3>
				<p className="mt-1 text-xs text-base-content/60">
					The Project shows this Work's thumbnail, so changing the Work's thumbnail later changes
					the Project's too.
				</p>
				{(works ?? []).length === 0 ? (
					<p className="mt-4 text-sm text-base-content/60">
						This Project holds no Works yet. Add some and their thumbnails will appear here.
					</p>
				) : (
					<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
						{(works ?? []).map((work) => {
							const selected = work.id === selectedId;
							const hasThumbnail = Boolean(work.thumbnail);
							return (
								<button
									key={work.id}
									type="button"
									disabled={busy || !hasThumbnail}
									aria-label={work.title ?? "Untitled Work"}
									aria-pressed={selected}
									onClick={() => onChoose(work.id)}
									className={`overflow-hidden rounded-lg border text-left transition-shadow disabled:cursor-not-allowed ${
										selected
											? "border-primary ring-2 ring-primary/40"
											: "border-base-300 hover:shadow-md disabled:opacity-60"
									}`}
								>
									{hasThumbnail ? (
										<img
											src={work.thumbnail ?? ""}
											alt=""
											className="aspect-video w-full object-cover"
										/>
									) : (
										<span className="flex aspect-video w-full items-center justify-center bg-base-200/50 text-xs text-base-content/40">
											No thumbnail yet
										</span>
									)}
									<span className="line-clamp-2 block p-2 text-xs font-medium">
										{work.title || "Untitled"}
									</span>
								</button>
							);
						})}
					</div>
				)}
				{busy && <p className="mt-4 text-xs text-base-content/60">Saving the thumbnail…</p>}
			</div>
		</div>
	);
}
