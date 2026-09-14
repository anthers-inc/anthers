// SPDX-License-Identifier: Apache-2.0
import { ArrowUpTrayIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useRef, useState } from "react";

interface FileUploadProps {
	accept?: string;
	maxSize?: number; // bytes
	onFileSelect: (file: File) => void;
	onClear?: () => void;
	preview?: string | null;
	label?: string;
	compact?: boolean;
}

export default function FileUpload({
	accept,
	maxSize,
	onFileSelect,
	onClear,
	preview,
	label = "Drop a file here or click to browse",
	compact = false,
}: FileUploadProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragOver, setDragOver] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fileName, setFileName] = useState<string | null>(null);

	const handleFile = useCallback(
		(file: File) => {
			setError(null);
			if (maxSize && file.size > maxSize) {
				const mb = (maxSize / 1024 / 1024).toFixed(0);
				setError(`File too large. Maximum size is ${mb} MB.`);
				return;
			}
			setFileName(file.name);
			onFileSelect(file);
		},
		[maxSize, onFileSelect],
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragOver(false);
			const file = e.dataTransfer.files[0];
			if (file) handleFile(file);
		},
		[handleFile],
	);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (file) handleFile(file);
		},
		[handleFile],
	);

	const handleClear = useCallback(() => {
		setFileName(null);
		setError(null);
		if (inputRef.current) inputRef.current.value = "";
		onClear?.();
	}, [onClear]);

	return (
		<div>
			{/* The drop zone is a real button so a file can be chosen from the keyboard — the
			    input is `display: none`, and the clickable div this used to be was reachable by
			    pointer only. Clear is a sibling laid over it rather than a child, because buttons
			    cannot nest; its offset is the zone's border plus padding. */}
			<div className="relative">
				<button
					type="button"
					aria-label={fileName || label}
					className={`block w-full border-2 border-dashed rounded-lg cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
						dragOver
							? "border-primary bg-primary/10"
							: "border-base-content/20 hover:border-primary/50"
					} ${compact ? "p-3" : "p-6"}`}
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={handleDrop}
					onClick={() => inputRef.current?.click()}
				>
					{preview ? (
						<img src={preview} alt="" className="max-h-48 mx-auto rounded object-contain" />
					) : (
						<span className="flex flex-col items-center gap-2 text-base-content/50">
							<ArrowUpTrayIcon className={compact ? "w-5 h-5" : "w-8 h-8"} />
							<span className={compact ? "text-xs" : "text-sm"}>{fileName || label}</span>
						</span>
					)}
				</button>
				{preview && onClear && (
					<button
						type="button"
						aria-label="Clear"
						className={`btn btn-circle btn-xs btn-error absolute ${
							compact
								? "top-[calc(1rem+2px)] right-[calc(1rem+2px)]"
								: "top-[calc(1.75rem+2px)] right-[calc(1.75rem+2px)]"
						}`}
						onClick={handleClear}
					>
						<XMarkIcon className="w-3 h-3" />
					</button>
				)}
			</div>
			<input
				ref={inputRef}
				type="file"
				accept={accept}
				onChange={handleChange}
				className="hidden"
			/>
			{error && <p className="text-error text-xs mt-1">{error}</p>}
		</div>
	);
}
