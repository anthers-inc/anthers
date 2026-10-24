// SPDX-License-Identifier: Apache-2.0
/**
 * Every kind renders a poster, and the poster names the kind it stands for.
 *
 * The map is a total `Record<WorkType, …>`, so a kind with no row is a compile error already.
 * What this suite adds is the runtime half: each `WORK_TYPES` entry reaches a drawing that
 * renders without throwing and carries its own name, and a kind from a newer build than this
 * one falls back rather than blowing up a listing. The posters are decoration with eleven
 * hand-drawn feet, which is exactly the kind of code where one foot indexes past its array.
 */
import { describe, expect, it } from "bun:test";
import { WORK_TYPES } from "@anthers/shared/content";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkPoster from "./work-poster";
import { typeLabel } from "./works";

const render = (type: string, props: Record<string, unknown> = {}): string =>
	renderToStaticMarkup(createElement(WorkPoster, { type, ...props }));

describe("WorkPoster", () => {
	it("renders every Work type, naming the kind", () => {
		for (const type of WORK_TYPES) {
			const html = render(type);
			expect(html).toContain(`data-work-type="${type}"`);
			expect(html).toContain(typeLabel(type));
		}
	});

	it("drops the kind's name at thumbnail size, keeping the drawing", () => {
		const html = render("video", { variant: "thumb" });
		expect(html).not.toContain(typeLabel("video"));
		expect(html).toContain('data-work-type="video"');
	});

	it("falls back rather than failing on a kind this build does not know", () => {
		expect(() => render("hologram")).not.toThrow();
		expect(render("hologram")).toContain('data-work-type="hologram"');
	});
});
