// SPDX-License-Identifier: Apache-2.0
/**
 * One drag or browse that hands back many files at once, in the picker's order.
 *
 * A local input rather than a `multiple` flag on the shared `FileUpload`, which every other
 * caller reads as strictly one file. Shared by the set editors and the new-version dialog so
 * all three order a pick the same way.
 */
import { useRef, useState } from "react";

export default function MultipleFileInput({
	onFiles,
	accept,
	label,
	disabled,
}: {
	onFiles: (files: File[]) => void;
	accept: string;
	label: string;
	disabled?: boolean;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [over, setOver] = useState(false);
	return (
		<div>
			<input
				style={{ display: "none" }}
				ref={inputRef}
				type="file"
				accept={accept}
				multiple
				onChange={(e) => {
					const files = Array.from(e.target.files ?? []);
					if (files.length > 0) onFiles(files);
					e.target.value = "";
				}}
			/>
			<button
				type="button"
				className={`flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-sm ${
					over ? "border-primary bg-primary/5" : "border-base-300"
				}`}
				onClick={() => inputRef.current?.click()}
				onDragOver={(e) => {
					e.preventDefault();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={(e) => {
					e.preventDefault();
					setOver(false);
					const files = Array.from(e.dataTransfer.files);
					if (files.length > 0 && !disabled) onFiles(files);
				}}
				disabled={disabled}
			>
				<span>{disabled ? "Working…" : label}</span>
			</button>
		</div>
	);
}
