// SPDX-License-Identifier: Apache-2.0
import { cloneElement, isValidElement, type ReactNode, useId } from "react";

interface FormFieldProps {
	label: string;
	error?: string;
	/**
	 * A line under the input saying something the label cannot — what happens if the field
	 * is left blank, what shape the value should take. Rendered below the control so it is
	 * read *after* the box it describes, and replaced by `error` when there is one, since
	 * two lines of small gray text under one input is how neither gets read.
	 */
	hint?: ReactNode;
	children: ReactNode;
	required?: boolean;
}

/** The controls a `<label htmlFor>` can name. Anything else keeps its own labeling. */
const LABELABLE = new Set(["input", "select", "textarea"]);

export default function FormField({ label, error, hint, children, required }: FormFieldProps) {
	// Tie the label to the control when the field wraps exactly one native control, which is
	// nearly every caller. Without it the label is text beside an unnamed input: a screen reader
	// announces "edit text", and clicking the label focuses nothing. A composite child — an
	// editor, an uploader, a group of controls — is left to label itself.
	const generatedId = useId();
	const control =
		isValidElement<{ id?: string }>(children) &&
		typeof children.type === "string" &&
		LABELABLE.has(children.type)
			? children
			: null;
	const controlId = control ? (control.props.id ?? generatedId) : undefined;

	// 🚨 `whitespace-normal` on every `.label`, and it is not cosmetic. daisyUI's `.label`
	// sets `white-space: nowrap` on an `inline-flex` box, so a hint or an error longer than
	// the field renders as ONE unbroken line and pushes the whole page sideways — /login's
	// "Leave it empty and we'll email you a sign-in code instead." ran 26px past a 390px
	// viewport. It is silent (no error, the class is right there in the DOM) and it is in a
	// SHARED component, so it reaches every form that has ever passed a long `hint` or
	// surfaced a long `error`. Found by `mobile-overflow.e2e.ts`; keep the class.
	return (
		<div className="form-control w-full">
			<label htmlFor={controlId} className="label whitespace-normal">
				<span className="label-text">
					{label}
					{required && <span className="text-error ml-1">*</span>}
				</span>
			</label>
			{control ? cloneElement(control, { id: controlId }) : children}
			{error ? (
				<div className="label whitespace-normal">
					<span className="label-text-alt text-error">{error}</span>
				</div>
			) : (
				hint && (
					<div className="label whitespace-normal">
						<span className="label-text-alt leading-relaxed text-base-content/55">{hint}</span>
					</div>
				)
			)}
		</div>
	);
}
