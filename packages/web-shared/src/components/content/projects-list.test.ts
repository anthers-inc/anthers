// SPDX-License-Identifier: Apache-2.0
/**
 * The Projects table's filtering and sorting derivation — the Works table's tests' twin
 * (`works-list.test.ts`): a silently-wrong filter matches an empty table instead of an
 * error, so the predicates and the NaN-free comparator are proven here rather than left
 * to the browser suite's eye.
 */
import { describe, expect, it } from "bun:test";
import type { Project, ProjectWorkSummary } from "../../lib/types";
import {
	arrangeProjects,
	DEFAULT_PROJECTS_SORT,
	filterProjects,
	sortProjects,
} from "./projects-list";

const summary = (over: Partial<ProjectWorkSummary>): ProjectWorkSummary => ({
	id: 1,
	title: null,
	type: "video",
	thumbnail: null,
	sortOrder: 0,
	...over,
});

function project(id: number, over: Partial<Project> = {}): Project {
	return {
		id,
		creatorId: 1,
		slug: `project-${id}`,
		title: `Project ${id}`,
		shortDescription: null,
		coverImage: null,
		pageConfig: null,
		isPublished: false,
		atprotoUri: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...over,
	} as Project;
}

const LIST: Project[] = [
	project(1, {
		title: "Tide Sessions",
		isPublished: true,
		createdAt: "2026-03-01T00:00:00Z",
		worksSummary: [summary({ id: 11, type: "music" }), summary({ id: 12, type: "video" })],
	}),
	project(2, { title: "Undertow", createdAt: "2026-02-01T00:00:00Z" }),
	// Works summaries absent — an old shape or a project with no works yet; the type
	// filter must match nothing rather than throwing.
	project(3, { title: "", createdAt: "2026-01-15T00:00:00Z" }),
];

describe("filterProjects", () => {
	it("shows everything when nothing is set", () => {
		expect(filterProjects(LIST, { q: "", status: "", type: "" })).toHaveLength(3);
	});

	it("matches a query against the title case-insensitively", () => {
		expect(filterProjects(LIST, { q: "tide", status: "", type: "" }).map((p) => p.id)).toEqual([1]);
	});

	it("treats an empty title as the Untitled the page shows", () => {
		expect(filterProjects(LIST, { q: "untitled", status: "", type: "" }).map((p) => p.id)).toEqual([
			3,
		]);
	});

	it("filters by published state, absent meaning draft", () => {
		expect(filterProjects(LIST, { q: "", status: "published", type: "" }).map((p) => p.id)).toEqual(
			[1],
		);
		const drafts = filterProjects(LIST, { q: "", status: "draft", type: "" });
		expect(drafts.map((p) => p.id)).toEqual([2, 3]);
	});

	it("filters by a Work kind the project holds, and a project with no works matches none", () => {
		expect(filterProjects(LIST, { q: "", status: "", type: "video" }).map((p) => p.id)).toEqual([
			1,
		]);
		expect(filterProjects(LIST, { q: "", status: "", type: "game" })).toHaveLength(0);
	});
});

describe("sortProjects", () => {
	it("orders by title with the default-named project where the word sorts it", () => {
		const titled = sortProjects(LIST, "title", "asc");
		expect(titled[titled.length - 1].id).toBe(3); // "Untitled"
	});

	it("sorts a Project the payload never dated oldest, never NaN", () => {
		const byDate = sortProjects([...LIST, project(4, { createdAt: undefined })], "date", "desc");
		expect(byDate[byDate.length - 1].id).toBe(4);
		expect(byDate[0].id).toBe(1);
	});
});

describe("arrangeProjects", () => {
	it("filters, then sorts", () => {
		const rows = arrangeProjects(LIST, { q: "tide", status: "", type: "" }, "date", "desc");
		expect(rows.map((p) => p.id)).toEqual([1]);
	});

	it("defaults to newest first", () => {
		expect(DEFAULT_PROJECTS_SORT).toEqual({ key: "date", dir: "desc" });
	});
});
