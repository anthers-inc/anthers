// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

interface FormFieldProps {
	label: string;
	error?: string;
	/**
	 * A line under the input saying something the label cannot — what happens if the field
	 * is left blank, what shape the value should take. Rendered below the control so it is
	 * read *after* the box it describes, and replaced by `error` when there is one, since
	 * two lines of small grey text under one input is how neither gets read.
	 */
	hint?: ReactNode;
	children: ReactNode;
	required?: boolean;
}

export default function FormField({ label, error, hint, children, required }: FormFieldProps) {
	return (
		<div className="form-control w-full">
			<label className="label">
				<span className="label-text">
					{label}
					{required && <span className="text-error ml-1">*</span>}
				</span>
			</label>
			{children}
			{error ? (
				<label className="label">
					<span className="label-text-alt text-error">{error}</span>
				</label>
			) : (
				hint && (
					<label className="label">
						<span className="label-text-alt leading-relaxed text-base-content/55">{hint}</span>
					</label>
				)
			)}
		</div>
	);
}
