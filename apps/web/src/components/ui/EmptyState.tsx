import type { ReactNode } from "react";

interface EmptyStateProps {
	icon?: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
}

export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			{icon && <div className="text-base-content/30 mb-4">{icon}</div>}
			<h3 className="text-lg font-semibold text-base-content/70">{title}</h3>
			{description && (
				<p className="mt-1 text-sm text-base-content/50 max-w-md">{description}</p>
			)}
			{action && <div className="mt-4">{action}</div>}
		</div>
	);
}
