// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

interface FormFieldProps {
	label: string;
	error?: string;
	children: ReactNode;
	required?: boolean;
}

export default function FormField({ label, error, children, required }: FormFieldProps) {
	return (
		<div className="form-control w-full">
			<label className="label">
				<span className="label-text">
					{label}
					{required && <span className="text-error ml-1">*</span>}
				</span>
			</label>
			{children}
			{error && (
				<label className="label">
					<span className="label-text-alt text-error">{error}</span>
				</label>
			)}
		</div>
	);
}
