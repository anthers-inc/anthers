// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `@` prefix, and the router behavior the whole design rests on.
 *
 * ⭐ **The second describe block is the important one.** `profileUrl` returning `/@name` is
 * barely worth asserting on its own; what is worth asserting is *why the `@` cannot live in
 * the route pattern instead*, because that is a fact about a dependency rather than about our
 * code, and nothing else in this repository would notice it changing. If React Router ever
 * learns partial-segment params, that block fails and the design gets simpler.
 */

import { describe, expect, it } from "bun:test";
import { matchPath } from "react-router-dom";
import {
	creatorPostUrl,
	creatorProjectUrl,
	creatorWorkUrl,
	displayHandle,
	profileUrl,
	usernameFromHandleParam,
} from "./profile";

describe("minting a profile URL", () => {
	it("prefixes the handle", () => {
		expect(profileUrl("anthers-parker")).toBe("/@anthers-parker");
		expect(displayHandle("anthers-parker")).toBe("@anthers-parker");
	});

	it("scopes a creator's own pages under it", () => {
		expect(creatorProjectUrl("parker", "meadow")).toBe("/@parker/meadow");
		expect(creatorPostUrl("parker", "hello")).toBe("/@parker/posts/hello");
		expect(creatorWorkUrl("parker", "the-game")).toBe("/@parker/works/the-game");
	});

	it("takes a numeric post id as readily as a slug, because the analytics table passes one", () => {
		expect(creatorPostUrl("parker", 41)).toBe("/@parker/posts/41");
	});
});

describe("reading a :handle route param", () => {
	it("returns the bare username", () => {
		expect(usernameFromHandleParam("@parker")).toBe("parker");
	});

	it("round-trips with profileUrl, so the two cannot drift apart", () => {
		const name = "anthers-parker";
		expect(usernameFromHandleParam(profileUrl(name).slice(1))).toBe(name);
	});

	it("🚨 refuses a segment that is not a handle, which is what makes a 404 possible", () => {
		// Each of these is a real path that reaches the `/:handle` route because the router
		// matches any single root segment. Returning a username for one would put them all
		// back to rendering a profile lookup.
		expect(usernameFromHandleParam("about")).toBeNull();
		expect(usernameFromHandleParam("studio")).toBeNull();
		expect(usernameFromHandleParam("demo-user")).toBeNull();
	});

	it("refuses a bare @ and a missing param", () => {
		expect(usernameFromHandleParam("@")).toBeNull();
		expect(usernameFromHandleParam(undefined)).toBeNull();
	});
});

describe("why the @ is in the value rather than the pattern", () => {
	it("🚨 React Router does NOT treat `/@:handle` as a dynamic segment", () => {
		// `compilePath` only recognizes `:param` where the colon follows a slash, so this
		// pattern compiles to a literal and matches no real URL at all — silently, with no
		// warning. Writing the route that way would 404 every profile on the site.
		expect(matchPath("/@:handle", "/@parker")).toBeNull();
	});

	it("matches the pattern we do use, and hands back the @ for us to strip", () => {
		const match = matchPath("/:handle", "/@parker");
		expect(match?.params.handle).toBe("@parker");
		expect(usernameFromHandleParam(match?.params.handle)).toBe("parker");
	});

	it("matches the nested creator routes the same way", () => {
		expect(matchPath("/:handle/works/:slug", "/@parker/works/the-game")?.params).toEqual({
			handle: "@parker",
			slug: "the-game",
		});
	});
});
