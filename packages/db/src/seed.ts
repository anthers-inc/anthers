// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Database seed script — creates fake creators with projects and posts.
 *
 * Usage:
 *   bun run db:seed          # seed (skip existing)
 *   bun run db:seed:reset    # delete seed data, then re-seed
 *
 * All seeded usernames start with "seed_" so they can be cleanly identified
 * and removed without affecting real data.
 */

import { eq, like } from "drizzle-orm";
import {
	assets,
	attentionEvents,
	bookmarks,
	boostAllocations,
	comments,
	contentItems,
	creatorGates,
	db,
	follows,
	poolDistributions,
	postContents,
	posts,
	projectPosts,
	projects,
	purchases,
	ratings,
	subscriptions,
	users,
} from "./index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SEED_PREFIX = "seed_";
const SEED_PASSWORD = "seedpassword123"; // not security-sensitive, dev only

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function randomInt(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n: number): Date {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return d;
}

const ACCESS_TIERS = ["free", "root", "sprout", "petal", "bloom"] as const;

/** The neutral Anthers table — every tier locked. */
function lockedAnthers() {
	return ACCESS_TIERS.map((tier) => ({ tier, allow: false, price: "0" }));
}

/** Free to everyone: the $0 boost baseline is allowed at price 0. */
function freeAccess() {
	return {
		anthersAccess: lockedAnthers(),
		boostAccess: [{ threshold: 0, allow: true, price: "0" }],
	};
}

/** Purchasable by anyone at `price` (the $0 boost baseline, priced). */
function paidAccess(price: string) {
	return { anthersAccess: lockedAnthers(), boostAccess: [{ threshold: 0, allow: true, price }] };
}

/** Subscriber-gated: any paid Anthers tier streams it free; everyone else is locked out. */
function subscriberGatedAccess() {
	return {
		anthersAccess: ACCESS_TIERS.map((tier) => ({ tier, allow: tier !== "free", price: "0" })),
		boostAccess: [{ threshold: 0, allow: false, price: "0" }],
	};
}

let publicIdSeq = 100_000_001;
function nextPublicId(): number {
	return publicIdSeq++;
}

// ---------------------------------------------------------------------------
// Seed data definitions
// ---------------------------------------------------------------------------

interface SeedCreator {
	username: string;
	email: string;
	displayName: string;
	bio: string;
	location: string;
	websiteUrl: string;
}

interface SeedProject {
	title: string;
	description: string;
	shortDescription: string;
	mediaType: string;
	tags: string[];
	pricingType: string;
	price?: string;
	minPrice?: string;
	suggestedPrice?: string;
}

interface SeedPost {
	title: string;
	body: string;
	contentType: string;
	visibility: string;
	estimatedReadMinutes?: number;
}

const CREATORS: SeedCreator[] = [
	{
		username: `${SEED_PREFIX}novapixel`,
		email: "novapixel@seed.anthers.dev",
		displayName: "Nova Pixel",
		bio: "Solo indie dev crafting pixel-art worlds and lo-fi soundtracks. Currently building Moonvale — a farming sim meets dungeon crawler. I release devlogs every Friday and all my OSTs are free to stream.",
		location: "Portland, OR",
		websiteUrl: "https://novapixel.dev",
	},
	{
		username: `${SEED_PREFIX}sagemoreno`,
		email: "sagemoreno@seed.anthers.dev",
		displayName: "Sage Moreno",
		bio: 'Writer, podcaster, occasional troublemaker. I write long-form essays on technology, culture, and the spaces between. My podcast "Undercurrents" explores stories that don\'t fit neatly into headlines.',
		location: "Brooklyn, NY",
		websiteUrl: "https://sage.ink",
	},
	{
		username: `${SEED_PREFIX}fluxbeats`,
		email: "fluxbeats@seed.anthers.dev",
		displayName: "FLUX",
		bio: "Electronic music producer, visual artist, live VJ. Releasing tracks, visuals, and the occasional interactive audio toy. Everything here is available under Creative Commons unless noted otherwise.",
		location: "Berlin, DE",
		websiteUrl: "https://fluxbeats.live",
	},
	{
		username: `${SEED_PREFIX}marisol`,
		email: "marisol@seed.anthers.dev",
		displayName: "Marisol Torres",
		bio: 'Illustrator and comic artist. I draw weird things and sometimes they turn into games. Currently serializing "Antumbra" — a sci-fi webcomic about light pollution and memory.',
		location: "Mexico City, MX",
		websiteUrl: "https://marisoltorres.art",
	},
	{
		username: `${SEED_PREFIX}hexbound`,
		email: "hexbound@seed.anthers.dev",
		displayName: "Hexbound Studio",
		bio: "Two-person studio making narrative horror games. We believe horror works best when it trusts the player's imagination. Our games are short, dense, and meant to be replayed.",
		location: "Glasgow, UK",
		websiteUrl: "https://hexbound.games",
	},
];

const PROJECTS_BY_CREATOR: Record<string, SeedProject[]> = {
	[`${SEED_PREFIX}novapixel`]: [
		{
			title: "Moonvale",
			description:
				"Farm by day, explore procedurally generated dungeons by night. Moonvale blends cozy farming sim mechanics with roguelike dungeon crawling. Grow crops, befriend villagers, and delve deeper into the caves beneath your farm to uncover the valley's ancient secrets.\n\nFeatures:\n- Seasonal farming with 40+ crops\n- Procedurally generated dungeon floors\n- 12 romanceable NPCs with branching storylines\n- Original lo-fi chiptune soundtrack\n- Local co-op support",
			shortDescription: "Farm by day, explore dungeons by night.",
			mediaType: "game",
			tags: ["rpg", "farming-sim", "pixel-art", "roguelike", "indie"],
			pricingType: "paid",
			price: "12.99",
		},
		{
			title: "Chroma Dash",
			description:
				"A speed-run platformer where the world shifts color palettes mid-level, changing which platforms are solid and which are passable. 60 hand-crafted levels across 4 worlds, plus a level editor with Steam Workshop support.\n\nMade for the 2025 Pixel Jam and expanded into a full release.",
			shortDescription: "Speed-run platformer with color-shifting mechanics.",
			mediaType: "game",
			tags: ["platformer", "speedrun", "pixel-art", "level-editor"],
			pricingType: "free",
		},
		{
			title: "Bit Dungeon OST",
			description:
				"24-track lo-fi chiptune album from the unreleased Bit Dungeon project. Composed entirely on a modded Game Boy using LSDJ. Free to stream, pay what you want to download.",
			shortDescription: "24-track lo-fi chiptune album.",
			mediaType: "audio",
			tags: ["chiptune", "lo-fi", "ost", "game-music"],
			pricingType: "pwyw",
			minPrice: "0.00",
			suggestedPrice: "3.00",
		},
		{
			title: "Starlit Caves",
			description:
				"A short puzzle game about bioluminescent ecosystems. Guide light through underground caverns by cultivating glowing fungi and redirecting water flows. A meditative experience with no fail states.",
			shortDescription: "A short puzzle game about bioluminescent ecosystems.",
			mediaType: "game",
			tags: ["puzzle", "relaxing", "pixel-art", "short"],
			pricingType: "free",
		},
	],
	[`${SEED_PREFIX}sagemoreno`]: [
		{
			title: "Undercurrents (Podcast)",
			description:
				"Long-form interviews and investigations into technology, culture, and power. New episodes every other Thursday. Free episodes are available to everyone; premium episodes drop a week early for subscribers.\n\n89 episodes and counting.",
			shortDescription: "Long-form interviews and investigations.",
			mediaType: "audio",
			tags: ["podcast", "technology", "culture", "interviews"],
			pricingType: "free",
		},
	],
	[`${SEED_PREFIX}fluxbeats`]: [
		{
			title: "Synthwave Toolkit",
			description:
				"A browser-based synthesizer with presets, recording, and MIDI support. Built with the Web Audio API and WebMIDI. Includes 30 presets ranging from classic analog pads to harsh digital leads.\n\nOpen source. Contributions welcome.",
			shortDescription: "Browser-based synth with presets and recording.",
			mediaType: "game",
			tags: ["music-tool", "synthesizer", "web-audio", "open-source"],
			pricingType: "free",
		},
		{
			title: "Visualizer Pack Vol. 3",
			description:
				"Reactive WebGL visuals for live DJ sets. 8 scenes that respond to audio input in real time. Compatible with OBS, Resolume, and standalone browser use.\n\nRequires a modern GPU with WebGL 2 support.",
			shortDescription: "Reactive WebGL visuals for live sets.",
			mediaType: "game",
			tags: ["visuals", "webgl", "live-performance", "creative-tools"],
			pricingType: "paid",
			price: "4.99",
		},
	],
	[`${SEED_PREFIX}marisol`]: [
		{
			title: "Antumbra: Chapter 1",
			description:
				"The first chapter of an interactive visual novel set in a city where artificial light has erased the night sky — and with it, certain kinds of memory. Point-and-click exploration with branching dialogue.\n\nEstimated playtime: 45-60 minutes.",
			shortDescription: "Interactive visual novel about light and memory.",
			mediaType: "game",
			tags: ["visual-novel", "narrative", "sci-fi", "point-and-click"],
			pricingType: "free",
		},
		{
			title: "Sketchbook Zine #4",
			description:
				"Digital zine collecting 6 months of sketches, studies, and process notes. 48 pages of pencil work, ink experiments, and color studies. PDF format.",
			shortDescription: "48-page digital sketchbook zine.",
			mediaType: "text",
			tags: ["zine", "illustration", "art", "sketchbook"],
			pricingType: "pwyw",
			minPrice: "0.00",
			suggestedPrice: "5.00",
		},
		{
			title: "Tile Garden",
			description:
				"A relaxing tile-placement puzzle game where you arrange illustrated garden tiles to create ecosystems. No timer, no score — just gardening.\n\n100 tiles across 5 biomes.",
			shortDescription: "Relaxing tile-placement puzzle game.",
			mediaType: "game",
			tags: ["puzzle", "relaxing", "illustration", "casual"],
			pricingType: "paid",
			price: "3.99",
		},
	],
	[`${SEED_PREFIX}hexbound`]: [
		{
			title: "The Quiet House",
			description:
				"A first-person narrative horror game set in a house that remembers everything you do. Every playthrough rearranges the house based on your previous choices. No jumpscares — just mounting dread.\n\nContent warnings: psychological horror, isolation, implied violence.\n\nPlaytime: 30-45 minutes per run. 4 endings.",
			shortDescription: "A house that remembers everything you do.",
			mediaType: "game",
			tags: ["horror", "narrative", "psychological", "replayable"],
			pricingType: "paid",
			price: "7.99",
		},
		{
			title: "Signal Return",
			description:
				"A radio operator receives transmissions from a station that went silent 30 years ago. Tune frequencies, decode messages, and piece together what happened — but be careful what you listen to.\n\nMade in 72 hours for Ludum Dare 57.",
			shortDescription: "Decode transmissions from a station that went silent.",
			mediaType: "game",
			tags: ["horror", "puzzle", "jam-game", "atmospheric"],
			pricingType: "free",
		},
		{
			title: "Hexbound Dev Commentary",
			description:
				"A collection of behind-the-scenes videos discussing the design and development of our games. Spoiler-heavy — play the games first!",
			shortDescription: "Behind-the-scenes design discussions.",
			mediaType: "video",
			tags: ["devlog", "game-design", "behind-the-scenes"],
			pricingType: "free",
		},
	],
};

const POSTS_BY_CREATOR: Record<string, SeedPost[]> = {
	[`${SEED_PREFIX}novapixel`]: [
		{
			title: "Moonvale Devlog #47 — The Fishing Update",
			body: "This week I added fishing to Moonvale. It took three attempts to get the casting mechanic right. The first version was too twitchy, the second was boring, and the third finally hit the sweet spot.\n\nThe key insight was tying the cast distance to a hold-and-release rather than a timing minigame. Players can focus on reading the water instead of watching a meter.\n\nI also added 12 fish species, each tied to specific seasons, times of day, and weather conditions. Rare fish appear during storms.\n\nNext week: cooking recipes that use fish ingredients.",
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 4,
		},
		{
			title: "How I Design Pixel Art Tilesets",
			body: "A breakdown of my tileset workflow, from initial sketches to final implementation.\n\n## 1. Establish the grid\n\nI always start with the grid size. Moonvale uses 16x16 tiles, which gives enough detail for readable objects without being overwhelming to draw.\n\n## 2. Define the palette\n\nI limit myself to 16 colors per biome. This forces cohesion and makes the tiles feel unified even when mixing and matching.\n\n## 3. Draw the basics first\n\nGrass, dirt, water, walls. Get these right before anything decorative. They'll cover 80% of your map.\n\n## 4. Add variation tiles\n\nThree variants of each base tile minimum. The eye notices repetition fast.\n\n## 5. Transition tiles\n\nThe unsexy but essential step. Grass-to-dirt, water-to-land. This is where tilesets feel professional or amateur.\n\nI use Aseprite for drawing and Tiled for testing layouts.",
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 8,
		},
	],
	[`${SEED_PREFIX}sagemoreno`]: [
		{
			title: "The Myth of the Neutral Platform",
			body: "Every platform has a point of view. The question is whether it's honest about it.\n\nWhen a platform says it's \"neutral,\" what it usually means is that it's optimized for engagement — which is itself a value judgment. Engagement optimization rewards outrage, novelty, and conflict. That's not neutrality; that's a specific editorial stance disguised as infrastructure.\n\nAnthers takes a different approach. By tying revenue to attention time rather than clicks, it changes what gets rewarded. Depth over virality. Completion over bounce.\n\nThis isn't neutral either — but at least it's legible. You can see the incentive structure and decide whether it aligns with your values.\n\nThe honest platforms of the future won't claim neutrality. They'll publish their values and let you choose.",
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 14,
		},
		{
			title: "Why I Left Substack (And What Comes Next)",
			body: "I've been on Substack for three years. In that time I built an audience of 11,000 readers, published 200+ pieces, and earned enough to make writing my full-time work.\n\nSo why leave?\n\nThree reasons:\n\n1. **Revenue share opacity.** I never fully understood what percentage Substack took and when. The fee structure changed twice while I was there.\n\n2. **Platform risk.** My mailing list was portable, but my archive, my comment threads, my subscriber relationships — all locked in.\n\n3. **Misaligned incentives.** Substack's recommendation algorithm pushed inflammatory content because it drove signups. My thoughtful, slow-burn essays were invisible to the algorithm.\n\nI'm moving to Anthers because the incentive structure makes sense to me: attention-weighted revenue means longer, more careful work gets rewarded. And the AT Protocol foundation means my content is mine, portable by design.\n\nThis isn't a subtweet. Substack served me well for a time. But the next phase of my work needs a different foundation.",
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 11,
		},
		{
			title: "Five Books That Changed How I Think About the Internet",
			body: 'These aren\'t the usual recommendations. No Zuboff, no Lanier (though both are worth reading). These are the books that changed how I *feel* about the internet, not just how I analyze it.\n\n1. **"A Pattern Language" by Christopher Alexander** — Not about the internet at all, but about how physical spaces shape behavior. Every platform designer should read it.\n\n2. **"The Mushroom at the End of the World" by Anna Tsing** — About supply chains, precarity, and how value gets created in the gaps between systems. The best metaphor for creator economies I\'ve found.\n\n3. **"Seeing Like a State" by James C. Scott** — About how institutions simplify the world to govern it, and what gets lost in the simplification. Essential reading for anyone thinking about content moderation.\n\n4. **"The Carrier Bag Theory of Fiction" by Ursula K. Le Guin** — A 5-page essay that reframes narrative from conquest to gathering. Changed how I think about feeds and timelines.\n\n5. **"Shop Class as Soulcraft" by Matthew B. Crawford** — About the dignity of manual work and the fraud of "knowledge work." Made me rethink what we mean by "content creation."',
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 9,
		},
	],
	[`${SEED_PREFIX}fluxbeats`]: [
		{
			title: "How I Build Reactive Visuals with Three.js",
			body: "A technical walkthrough of my live visual setup.\n\n## The Audio Pipeline\n\nI use the Web Audio API's `AnalyserNode` to get frequency and waveform data in real time. The key parameters:\n\n- `fftSize`: 2048 (good balance of frequency resolution and performance)\n- `smoothingTimeConstant`: 0.8 (prevents jittery visuals)\n\n## Mapping Audio to Geometry\n\nI split the frequency spectrum into 4 bands:\n- Sub-bass (20-60Hz): drives camera shake and scene-wide effects\n- Bass (60-250Hz): controls geometry scale\n- Mid (250-4000Hz): modulates color and material properties\n- High (4000-20000Hz): triggers particle effects\n\n## Performance\n\nThe biggest bottleneck is texture updates. I pre-allocate all textures at startup and cycle through them rather than creating/destroying. With this approach I can maintain 60fps on a mid-range GPU while driving 8 reactive scenes simultaneously.\n\n## Source Code\n\nThe visualizer framework is open source — check the project page for the repo link.",
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 12,
		},
		{
			title: 'Remix Contest: Submit Your Take on "Neon Rain"',
			body: 'Taking the stems from my latest track "Neon Rain" and opening them up for remixes.\n\n**Rules:**\n- Download the stems from the Synthwave Toolkit project page\n- Use at least 2 of the original stems\n- Any genre welcome\n- Submit by March 31, 2026\n- Winners get featured on my page and a free copy of Visualizer Pack Vol. 4 (when it drops)\n\nPost your remix as a project on Anthers and tag it `neon-rain-remix`. I\'ll listen to every submission.\n\nNo rights transfer — you keep full ownership of your remix.',
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 3,
		},
	],
	[`${SEED_PREFIX}marisol`]: [
		{
			title: "Antumbra Production Diary — Week 12",
			body: "This week was all about lighting. In Antumbra, light is both a game mechanic and a narrative device — the city's omnipresent artificial illumination has erased certain kinds of memory tied to darkness and dreaming.\n\nI spent three days painting the \"twilight district\" backgrounds, where old sodium-vapor streetlights create pockets of amber warmth against the cold white LED grid. The contrast needed to feel meaningful, not just aesthetic.\n\nThe point-and-click interactions are coming together. I'm using a verb-coin system (look, talk, use) rather than a parser or single-click. It slows the pace, which is intentional — I want players to sit with each scene.\n\nNext week: writing the dialogue for the Librarian, the first NPC you meet.",
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 5,
		},
		{
			title: "Drawing Process: From Sketch to Final Illustration",
			body: "People often ask about my process, so here's a breakdown of how I took the Antumbra cover illustration from rough sketch to final piece.\n\n## Rough Thumbnails\n\nI start with tiny (2x3 inch) thumbnails to nail the composition. No detail, just shapes and values. I usually do 10-15 of these before committing to one.\n\n## Line Drawing\n\nOnce I have a composition, I do a clean line drawing at full resolution (4000x6000px). I use a hard round brush at 3px in Procreate.\n\n## Flat Colors\n\nI fill in flat colors on separate layers. This is where the palette gets established. For Antumbra, I'm working with a limited palette of 8 colors per scene.\n\n## Rendering\n\nI render on a single layer above the flats, using multiply and overlay blend modes. The goal is to maintain the graphic quality of the flat colors while adding depth.\n\n## Final Passes\n\nColor correction, atmospheric effects (fog, light bloom), and texture overlays. I use scanned paper textures at low opacity to add warmth.\n\nTotal time for this piece: about 14 hours across 3 days.",
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 7,
		},
	],
	[`${SEED_PREFIX}hexbound`]: [
		{
			title: "Designing Horror Without Jumpscares",
			body: "Jumpscares are the horror equivalent of a laugh track. They tell the audience when to be scared rather than letting the feeling emerge naturally.\n\nAt Hexbound, we've committed to making horror games with zero jumpscares. Here's how we create dread instead:\n\n## 1. Violation of Routine\n\nEstablish a pattern, then break it. In The Quiet House, doors open to the same rooms for the first 10 minutes. Then one doesn't. The player notices because they've internalized the pattern.\n\n## 2. Negative Space\n\nWhat you don't show is more frightening than what you do. We leave rooms slightly too empty, corridors slightly too long, silences slightly too extended.\n\n## 3. Player Complicity\n\nThe most effective horror makes the player feel responsible. In The Quiet House, the house changes based on your choices. You created the thing that frightens you.\n\n## 4. Sound Design\n\nOur sound designer spends more time on what we call \"almost sounds\" — ambiguous audio that might be footsteps, might be the house settling, might be nothing. The player's pattern-matching brain does the rest.\n\n## 5. Respect the Player\n\nTrust them to be scared without shoving it in their face. If your horror only works with a loud noise and a sudden image, it's not horror — it's reflex testing.",
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 6,
		},
		{
			title: "Signal Return Postmortem — 72 Hours of Panic",
			body: 'Signal Return was our Ludum Dare 57 entry. The theme was "Echoes." We finished with 4 hours to spare, which for us is practically luxurious.\n\n## What Went Right\n\n- **Scoping.** We committed to a single mechanic (radio tuning) and one environment (the radio station). No feature creep.\n- **Audio-first design.** We recorded all the radio transmissions on day 1 and built the game around them. This meant the narrative was locked before we wrote a line of code.\n- **The frequency mechanic.** Using a continuous dial instead of discrete channels made the experience feel analog and tactile.\n\n## What Went Wrong\n\n- **The UI.** We ran out of time to make the frequency display readable. Players had trouble distinguishing between frequencies that were 0.1 apart.\n- **No save system.** For a 20-minute game this is fine, but several players reported wanting to replay specific sequences.\n- **Web build issues.** The WebAudio API behaves differently across browsers. We spent 6 hours debugging Firefox-specific timing issues.\n\n## Numbers\n\n- 2,400 plays in the first week\n- 4.1/5 average rating (jam category)\n- 89 comments\n\nWe\'re expanding Signal Return into a full release. Expect a longer campaign, better UI, and new transmission sources.',
			contentType: "text",
			visibility: "public",
			estimatedReadMinutes: 8,
		},
	],
};

// Sample comments from non-creator users
const COMMENT_BODIES = [
	"This is incredible work. The attention to detail really shows.",
	"Been following this project for months — can't wait for the full release.",
	"Really thoughtful approach. More creators should think about it this way.",
	"This changed how I think about game design. Thank you for sharing.",
	"Just bought this and I'm blown away. Worth every penny.",
	"The soundtrack alone is worth the download. Beautiful work.",
	"Played through twice already. The replayability is real.",
	"As a fellow developer, the technical breakdown is super appreciated.",
	"Shared this with my entire team. Essential reading.",
	"First time on Anthers and this is the kind of content that'll keep me here.",
	"The aesthetic is so cohesive. Everything fits together perfectly.",
	"Would love to see a follow-up on this topic.",
	"This is exactly what I was looking for. Bookmarked.",
	"Incredible atmosphere. I could feel the tension building.",
	"Your process breakdowns are always so generous. Thank you.",
];

// ---------------------------------------------------------------------------
// Test users (non-creators — for testing the subscriber experience)
// ---------------------------------------------------------------------------

interface SeedBookmark {
	type: "project" | "post" | "creator";
	/** Project title, post title, or creator username */
	ref: string;
}

interface SeedUser {
	username: string;
	email: string;
	displayName: string;
	bio: string;
	tier: "free" | "sprout";
	/** Usernames of creators this user follows */
	follows: string[];
	/** Project titles this user has purchased */
	purchaseTitles: string[];
	/** Attention time targets (seconds) per creator username */
	attentionTargets: Record<string, { seconds: number; eventTypes: string[] }>;
	/** Bookmarked items (ordered — first item = sortOrder 0) */
	bookmarks: SeedBookmark[];
}

const TEST_USERS: SeedUser[] = [
	{
		username: `${SEED_PREFIX}casey`,
		email: "casey@seed.anthers.dev",
		displayName: "Casey Rivera",
		bio: "Games, podcasts, and too many open tabs.",
		tier: "sprout",
		follows: [
			`${SEED_PREFIX}novapixel`,
			`${SEED_PREFIX}sagemoreno`,
			`${SEED_PREFIX}marisol`,
			`${SEED_PREFIX}hexbound`,
		],
		purchaseTitles: ["Moonvale", "Tile Garden"],
		attentionTargets: {
			[`${SEED_PREFIX}novapixel`]: { seconds: 29520, eventTypes: ["play", "read"] }, // ~8.2 hrs
			[`${SEED_PREFIX}sagemoreno`]: { seconds: 23400, eventTypes: ["read", "listen"] }, // ~6.5 hrs
			[`${SEED_PREFIX}hexbound`]: { seconds: 18360, eventTypes: ["play", "read"] }, // ~5.1 hrs
			[`${SEED_PREFIX}marisol`]: { seconds: 10800, eventTypes: ["play", "read"] }, // ~3.0 hrs
			[`${SEED_PREFIX}fluxbeats`]: { seconds: 5400, eventTypes: ["play"] }, // ~1.5 hrs
		},
		bookmarks: [
			{ type: "project", ref: "Moonvale" },
			{ type: "post", ref: "The Myth of the Neutral Platform" },
			{ type: "creator", ref: `${SEED_PREFIX}hexbound` },
			{ type: "post", ref: "Designing Horror Without Jumpscares" },
			{ type: "project", ref: "Antumbra: Chapter 1" },
		],
	},
	{
		username: `${SEED_PREFIX}jordan`,
		email: "jordan@seed.anthers.dev",
		displayName: "Jordan Park",
		bio: "Lurker turned listener. Mostly here for the music and the horror games.",
		tier: "free",
		follows: [
			`${SEED_PREFIX}fluxbeats`,
			`${SEED_PREFIX}marisol`,
			`${SEED_PREFIX}novapixel`,
			`${SEED_PREFIX}hexbound`,
		],
		purchaseTitles: ["The Quiet House"],
		attentionTargets: {
			[`${SEED_PREFIX}novapixel`]: { seconds: 10800, eventTypes: ["play", "read"] }, // ~3.0 hrs
			[`${SEED_PREFIX}fluxbeats`]: { seconds: 7200, eventTypes: ["play", "listen"] }, // ~2.0 hrs
			[`${SEED_PREFIX}marisol`]: { seconds: 5400, eventTypes: ["play", "read"] }, // ~1.5 hrs
			[`${SEED_PREFIX}sagemoreno`]: { seconds: 1800, eventTypes: ["read"] }, // ~0.5 hrs
		},
		bookmarks: [
			{ type: "project", ref: "The Quiet House" },
			{ type: "creator", ref: `${SEED_PREFIX}fluxbeats` },
			{ type: "post", ref: "How I Build Reactive Visuals with Three.js" },
			{ type: "project", ref: "Signal Return" },
		],
	},
];

// ---------------------------------------------------------------------------
// Attention event generation helpers
// ---------------------------------------------------------------------------

function currentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function billingCycleStart(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), 1);
}

function billingCycleEnd(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

/**
 * Generate a batch of attention events that sum to approximately `targetSeconds`.
 * Events are spread across days in the current billing cycle with realistic durations.
 */
function buildAttentionEvents(
	userId: number,
	creatorId: number,
	targetSeconds: number,
	eventTypes: string[],
): {
	userId: number;
	creatorId: number;
	eventType: string;
	durationSeconds: number;
	createdAt: Date;
}[] {
	const events: ReturnType<typeof buildAttentionEvents> = [];
	const start = billingCycleStart();
	const now = new Date();
	const daysElapsed = Math.max(
		1,
		Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)),
	);

	let remaining = targetSeconds;
	while (remaining > 0) {
		const duration = Math.min(remaining, randomInt(30, 300));
		const day = randomInt(0, daysElapsed - 1);
		const date = new Date(start);
		date.setDate(date.getDate() + day);
		date.setHours(randomInt(8, 23), randomInt(0, 59), randomInt(0, 59));

		events.push({
			userId,
			creatorId,
			eventType: pick(eventTypes),
			durationSeconds: duration,
			createdAt: date,
		});
		remaining -= duration;
	}
	return events;
}

// ---------------------------------------------------------------------------
// Seed logic
// ---------------------------------------------------------------------------

async function cleanSeedData() {
	console.log("Cleaning existing seed data...");

	// Delete in reverse FK order: comments/ratings -> posts -> projects -> users
	// CASCADE handles most of this, but we delete users which cascades everything
	const seedUsers = await db
		.select({ id: users.id })
		.from(users)
		.where(like(users.username, `${SEED_PREFIX}%`));

	if (seedUsers.length === 0) {
		console.log("  No existing seed data found.");
		return;
	}

	for (const u of seedUsers) {
		await db.delete(users).where(eq(users.id, u.id));
	}

	console.log(`  Deleted ${seedUsers.length} seed users (and cascaded content).`);
}

async function seed() {
	const passwordHash = await Bun.password.hash(SEED_PASSWORD, {
		algorithm: "argon2id",
	});

	const createdUserIds: Record<string, number> = {};
	// Everything published is a Post now; track them for ratings/comments/collections.
	const createdPosts: { postId: number; creatorUsername: string }[] = [];
	const postIdBySlug: Record<string, number> = {};
	const postIdByTitle: Record<string, number> = {};
	// Base purchase price per work title (works now express pricing via access tables).
	const priceByTitle: Record<string, string> = {};

	const recordPost = (postId: number, slug: string, title: string, username: string) => {
		createdPosts.push({ postId, creatorUsername: username });
		postIdBySlug[slug] = postId;
		postIdByTitle[title] = postId;
	};

	// ---- 1. Create users ----
	console.log("Creating seed creators...");
	for (const creator of CREATORS) {
		// Check if already exists
		const existing = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, creator.username))
			.limit(1);

		if (existing.length > 0) {
			console.log(`  Skipping ${creator.username} (already exists)`);
			createdUserIds[creator.username] = existing[0].id;
			continue;
		}

		const [inserted] = await db
			.insert(users)
			.values({
				username: creator.username,
				email: creator.email,
				passwordHash,
				displayName: creator.displayName,
				bio: creator.bio,
				isCreator: true,
				location: creator.location,
				websiteUrl: creator.websiteUrl,
				emailVerified: true,
			})
			.returning({ id: users.id });

		createdUserIds[creator.username] = inserted.id;
		console.log(`  Created ${creator.username} (id: ${inserted.id})`);
	}

	// ---- 2. Create works (download/priced posts) ----
	// Former standalone "projects" (downloadable works) are now posts: download-enabled,
	// carrying the pricing. mediaType → contentType; pricingType → entitlement pricing.
	console.log("Creating seed works (posts)...");
	for (const [username, creatorWorks] of Object.entries(PROJECTS_BY_CREATOR)) {
		const creatorId = createdUserIds[username];
		if (!creatorId) continue;

		for (const work of creatorWorks) {
			const slug = slugify(work.title);

			const existing = await db
				.select({ id: posts.id })
				.from(posts)
				.where(eq(posts.slug, slug))
				.limit(1);

			if (existing.length > 0) {
				console.log(`  Skipping work "${work.title}" (slug exists)`);
				recordPost(existing[0].id, slug, work.title, username);
				continue;
			}

			// Delivery by type: games download-only, video stream-only, audio/text both.
			const delivery =
				work.mediaType === "game"
					? { streamEnabled: false, downloadEnabled: true }
					: work.mediaType === "video"
						? { streamEnabled: true, downloadEnabled: false }
						: { streamEnabled: true, downloadEnabled: true };

			// pricingType → the two access tables + a recorded base price for purchases.
			const price =
				work.pricingType === "paid"
					? (work.price ?? "0.00")
					: work.pricingType === "pwyw"
						? (work.minPrice ?? "0.00")
						: "0.00";
			priceByTitle[work.title] = price;
			const access = work.pricingType === "free" ? freeAccess() : paidAccess(price);

			const [inserted] = await db
				.insert(posts)
				.values({
					creatorId,
					publicId: nextPublicId(),
					slug,
					title: work.title,
					body: work.description,
					bodyHtml: `<p>${work.description.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
					contentType: work.mediaType,
					...delivery,
					...access,
					tags: work.tags,
					isPublished: true,
					viewCount: randomInt(50, 5000),
					downloadCount: randomInt(10, 2000),
					createdAt: daysAgo(randomInt(30, 180)),
				})
				.returning({ id: posts.id });

			// Media works become a library content item the post references; text works
			// stay post-native (body only). Download works get a build asset on the item.
			if (work.mediaType !== "text") {
				const [item] = await db
					.insert(contentItems)
					.values({
						creatorId,
						type: work.mediaType,
						title: work.title,
						description: work.shortDescription,
					})
					.returning({ id: contentItems.id });
				await db
					.insert(postContents)
					.values({ postId: inserted.id, position: 0, kind: "content", contentItemId: item.id });
				if (delivery.downloadEnabled) {
					await db.insert(assets).values({
						contentItemId: item.id,
						file: `creators/${creatorId}/assets/seed-${slug}.zip`,
						filename: `${slug}.zip`,
						fileSize: randomInt(50, 800) * 1024 * 1024,
						mimeType: "application/zip",
						platform: work.mediaType === "game" ? "windows" : "",
					});
				}
			}

			recordPost(inserted.id, slug, work.title, username);
			console.log(`  Created work "${work.title}" (id: ${inserted.id})`);
		}
	}

	// ---- 3. Create text/stream posts ----
	// Former stream posts stay posts: stream-only, free. A non-"public" seed visibility
	// becomes a subscriber (tier) gate to exercise the entitlement path.
	console.log("Creating seed posts...");
	for (const [username, creatorPosts] of Object.entries(POSTS_BY_CREATOR)) {
		const creatorId = createdUserIds[username];
		if (!creatorId) continue;

		for (const post of creatorPosts) {
			const slug = slugify(post.title);

			const existing = await db
				.select({ id: posts.id })
				.from(posts)
				.where(eq(posts.slug, slug))
				.limit(1);

			if (existing.length > 0) {
				console.log(`  Skipping post "${post.title}" (slug exists)`);
				recordPost(existing[0].id, slug, post.title, username);
				continue;
			}

			const gated = post.visibility && post.visibility !== "public";

			const [inserted] = await db
				.insert(posts)
				.values({
					creatorId,
					slug,
					title: post.title,
					body: post.body,
					bodyHtml: `<p>${post.body.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
					contentType: post.contentType,
					publicId: nextPublicId(),
					streamEnabled: true,
					downloadEnabled: false,
					...(gated ? subscriberGatedAccess() : freeAccess()),
					isPublished: true,
					estimatedReadMinutes: post.estimatedReadMinutes ?? null,
					createdAt: daysAgo(randomInt(1, 60)),
				})
				.returning({ id: posts.id });

			recordPost(inserted.id, slug, post.title, username);
			console.log(`  Created post "${post.title}" (id: ${inserted.id})`);
		}
	}

	// ---- 3b. Create collections (projects) grouping each creator's works ----
	console.log("Creating seed collections...");
	for (const [username, creatorWorks] of Object.entries(PROJECTS_BY_CREATOR)) {
		const creatorId = createdUserIds[username];
		if (!creatorId || creatorWorks.length < 2) continue;

		const displayName = CREATORS.find((c) => c.username === username)?.displayName ?? username;
		const collSlug = slugify(`${username}-selected-works`);

		const existing = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, collSlug))
			.limit(1);

		let projectId: number;
		if (existing.length > 0) {
			projectId = existing[0].id;
		} else {
			const [proj] = await db
				.insert(projects)
				.values({
					creatorId,
					slug: collSlug,
					title: `${displayName} — Selected Works`,
					description: `A curated collection of ${displayName}'s works.`,
					shortDescription: "Selected works",
					isPublished: true,
				})
				.returning({ id: projects.id });
			projectId = proj.id;
		}

		let order = 0;
		for (const work of creatorWorks) {
			const postId = postIdBySlug[slugify(work.title)];
			if (!postId) continue;
			try {
				await db.insert(projectPosts).values({ projectId, postId, sortOrder: order++ });
			} catch {
				// unique (project_id, post_id) — already linked
			}
		}
	}
	console.log("  Collections created.");

	// ---- 4. Create some ratings ----
	console.log("Creating seed ratings...");
	const allUserIds = Object.values(createdUserIds);

	for (const { postId, creatorUsername } of createdPosts) {
		// Each creator's posts get rated by the other seed users.
		const raters = allUserIds.filter((id) => id !== createdUserIds[creatorUsername]);

		for (const raterId of raters) {
			const score = randomInt(3, 5); // seed data skews positive
			try {
				await db.insert(ratings).values({
					userId: raterId,
					postId,
					score,
					createdAt: daysAgo(randomInt(1, 90)),
				});
			} catch {
				// Unique constraint (user_id, post_id) — already rated
			}
		}
	}
	console.log("  Ratings created.");

	// ---- 5. Create some comments ----
	console.log("Creating seed comments...");
	for (const { postId, creatorUsername } of createdPosts) {
		const commenters = allUserIds.filter((id) => id !== createdUserIds[creatorUsername]);

		// 1-3 comments per post
		const numComments = randomInt(1, 3);
		for (let i = 0; i < numComments && i < commenters.length; i++) {
			try {
				await db.insert(comments).values({
					userId: commenters[i],
					postId,
					body: pick(COMMENT_BODIES),
					createdAt: daysAgo(randomInt(1, 60)),
				});
			} catch {
				// skip duplicates
			}
		}
	}
	console.log("  Comments created.");

	// ---- 6. Create creator gates ----
	console.log("Creating creator gates...");

	// Gate definitions per creator: mix of Anthers Tier gates and Boost gates
	const GATES_BY_CREATOR: Record<
		string,
		{ gateType: string; threshold: string; label: string; description: string }[]
	> = {
		[`${SEED_PREFIX}novapixel`]: [
			{
				gateType: "anthers_tier",
				threshold: "3.00",
				label: "Root",
				description: "Early devlogs and behind-the-scenes screenshots",
			},
			{
				gateType: "anthers_tier",
				threshold: "7.00",
				label: "Sprout",
				description: "Beta access to in-progress builds",
			},
			{
				gateType: "boost",
				threshold: "2.00",
				label: "Pixel Pal",
				description: "Weekly pixel art WIP threads",
			},
			{
				gateType: "boost",
				threshold: "5.00",
				label: "Playtester",
				description: "Access to private playtesting branches and feedback channels",
			},
		],
		[`${SEED_PREFIX}sagemoreno`]: [
			{
				gateType: "anthers_tier",
				threshold: "3.00",
				label: "Root",
				description: "Early access to essays (one week before public)",
			},
			{
				gateType: "boost",
				threshold: "2.00",
				label: "Reader",
				description: "Extended footnotes and research notes",
			},
			{
				gateType: "boost",
				threshold: "5.00",
				label: "Inner Circle",
				description: "Monthly AMA threads and draft previews",
			},
			{
				gateType: "boost",
				threshold: "10.00",
				label: "Patron",
				description: "Annual long-form piece dedicated to patron questions",
			},
		],
		[`${SEED_PREFIX}fluxbeats`]: [
			{
				gateType: "anthers_tier",
				threshold: "3.00",
				label: "Root",
				description: "Stems and project files for released tracks",
			},
			{
				gateType: "boost",
				threshold: "3.00",
				label: "Listener",
				description: "Early access to new releases (48-hour window)",
			},
			{
				gateType: "boost",
				threshold: "8.00",
				label: "Collaborator",
				description: "Unreleased demos, remix packs, and sample libraries",
			},
		],
		[`${SEED_PREFIX}marisol`]: [
			{
				gateType: "anthers_tier",
				threshold: "3.00",
				label: "Root",
				description: "High-resolution art downloads",
			},
			{
				gateType: "anthers_tier",
				threshold: "15.00",
				label: "Petal",
				description: "Exclusive print-ready illustrations",
			},
			{
				gateType: "boost",
				threshold: "2.00",
				label: "Sketch Club",
				description: "Weekly process videos and timelapse recordings",
			},
			{
				gateType: "boost",
				threshold: "6.00",
				label: "Studio Access",
				description: "Full PSD/Procreate files and custom brush packs",
			},
		],
		[`${SEED_PREFIX}hexbound`]: [
			{
				gateType: "anthers_tier",
				threshold: "7.00",
				label: "Sprout",
				description: "Director's commentary audio tracks for all games",
			},
			{
				gateType: "boost",
				threshold: "3.00",
				label: "Insider",
				description: "Monthly design documents and narrative outlines",
			},
			{
				gateType: "boost",
				threshold: "7.00",
				label: "Patron",
				description: "Playable prototypes and experimental builds",
			},
			{
				gateType: "boost",
				threshold: "15.00",
				label: "Producer",
				description: "Vote on next game concept, name in credits",
			},
		],
	};

	for (const [username, gates] of Object.entries(GATES_BY_CREATOR)) {
		const creatorId = createdUserIds[username];
		if (!creatorId) continue;

		for (let gi = 0; gi < gates.length; gi++) {
			const gate = gates[gi];
			try {
				await db.insert(creatorGates).values({
					creatorId,
					gateType: gate.gateType,
					threshold: gate.threshold,
					label: gate.label,
					description: gate.description,
					sortOrder: gi,
				});
			} catch {
				// skip duplicates on re-seed
			}
		}
	}
	console.log(`  ${Object.values(GATES_BY_CREATOR).flat().length} creator gates created.`);

	// ---- 7. Create test users (subscribers) ----
	console.log("Creating test users...");
	const testUserIds: Record<string, number> = {};

	for (const tu of TEST_USERS) {
		const existing = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, tu.username))
			.limit(1);

		if (existing.length > 0) {
			console.log(`  Skipping ${tu.username} (already exists)`);
			testUserIds[tu.username] = existing[0].id;
			continue;
		}

		const [inserted] = await db
			.insert(users)
			.values({
				username: tu.username,
				email: tu.email,
				passwordHash,
				displayName: tu.displayName,
				bio: tu.bio,
				isCreator: false,
				emailVerified: true,
			})
			.returning({ id: users.id });

		testUserIds[tu.username] = inserted.id;
		console.log(`  Created ${tu.username} (id: ${inserted.id})`);

		const userId = inserted.id;

		// -- Follows --
		for (const creatorUsername of tu.follows) {
			const creatorId = createdUserIds[creatorUsername];
			if (!creatorId) continue;
			try {
				await db.insert(follows).values({ followerId: userId, creatorId });
			} catch {
				// unique constraint — already exists
			}
		}
		console.log(`    ${tu.follows.length} follows`);

		// -- Purchases -- (purchaseTitles reference former works, now posts)
		for (const title of tu.purchaseTitles) {
			const slug = slugify(title);
			const [p] = await db
				.select({ id: posts.id })
				.from(posts)
				.where(eq(posts.slug, slug))
				.limit(1);

			if (!p) {
				console.log(`    Skipping purchase "${title}" (post not found)`);
				continue;
			}

			const amount = parseFloat(priceByTitle[title] ?? "0");
			if (amount <= 0) continue;

			const processingFee = Math.round((amount * 0.029 + 0.3) * 100) / 100;
			const crfFee = Math.round(amount * 0.08 * 100) / 100; // 8% Anthers Foundation Fee
			// Pass-through: the creator keeps the full listed price; fees ride on top.
			const creatorEarnings = amount;
			const fakePaymentId = `pi_seed_${tu.username}_${slug}`;

			try {
				await db.insert(purchases).values({
					buyerId: userId,
					postId: p.id,
					amount: amount.toFixed(2),
					processingFee: processingFee.toFixed(2),
					crfFee: crfFee.toFixed(2),
					creatorEarnings: creatorEarnings.toFixed(2),
					stripePaymentIntentId: fakePaymentId,
					status: "completed",
				});
			} catch {
				// unique constraint on stripePaymentIntentId
			}
		}
		console.log(`    ${tu.purchaseTitles.length} purchases`);

		// -- Subscription --
		const cycleStart = billingCycleStart();
		const cycleEnd = billingCycleEnd();
		const tierPrices: Record<string, number> = {
			free: 0,
			root: 3,
			sprout: 7,
			petal: 15,
			bloom: 30,
		};
		try {
			await db.insert(subscriptions).values({
				userId,
				tier: tu.tier,
				fundingLevel: tierPrices[tu.tier] ?? 0,
				isActive: true,
				currentPeriodStart: cycleStart,
				currentPeriodEnd: cycleEnd,
			});
		} catch {
			// unique constraint on userId
		}
		console.log(`    subscription: ${tu.tier}`);

		// -- Attention events --
		let totalEvents = 0;
		for (const [creatorUsername, target] of Object.entries(tu.attentionTargets)) {
			const creatorId = createdUserIds[creatorUsername];
			if (!creatorId) continue;

			const events = buildAttentionEvents(userId, creatorId, target.seconds, target.eventTypes);
			// Batch insert in chunks of 100
			for (let i = 0; i < events.length; i += 100) {
				const chunk = events.slice(i, i + 100);
				await db.insert(attentionEvents).values(chunk);
			}
			totalEvents += events.length;
		}
		console.log(`    ${totalEvents} attention events`);

		// -- Pool distributions (paid users only) --
		if (tu.tier !== "free") {
			// V2 economics: boostPool = ceil(fundingLevel × 0.5), timePool = creatorShare − boostPool
			const fundLevel = tierPrices[tu.tier] ?? 0;
			const creatorShare = Math.round(fundLevel * 0.92 * 100) / 100;
			const boostPool = Math.ceil(fundLevel * 0.5);
			const timePool = Math.round((creatorShare - boostPool) * 100) / 100;

			// Compute attention proportions
			const entries = Object.entries(tu.attentionTargets);
			const totalSeconds = entries.reduce((sum, [, t]) => sum + t.seconds, 0);
			const cycle = currentBillingCycle();

			// First pass: compute $1-rounded boost amounts, then assign leftover to time pool
			const boostAmounts = new Map<string, number>();
			let totalAllocatedBoost = 0;
			for (const [creatorUsername, target] of entries) {
				const proportion = target.seconds / totalSeconds;
				const boostAmt = Math.floor(boostPool * proportion); // $1 increments
				boostAmounts.set(creatorUsername, boostAmt);
				totalAllocatedBoost += boostAmt;
			}
			// Unallocated boost (from rounding) goes back to time pool
			const effectiveTimePool = timePool + (boostPool - totalAllocatedBoost);

			for (const [creatorUsername, target] of entries) {
				const creatorId = createdUserIds[creatorUsername];
				if (!creatorId) continue;

				const proportion = target.seconds / totalSeconds;
				const poolAmt = Math.round(effectiveTimePool * proportion * 100) / 100;
				const boostAmt = boostAmounts.get(creatorUsername) ?? 0;

				try {
					await db.insert(poolDistributions).values({
						subscriberId: userId,
						creatorId,
						billingCycle: cycle,
						poolAmount: poolAmt.toFixed(2),
						boostAmount: boostAmt.toFixed(2),
						attentionSeconds: target.seconds,
					});
				} catch {
					// unique constraint
				}
			}
			// -- Boost allocations (matching pool distribution proportions, $1 increments) --
			for (const [creatorUsername] of entries) {
				const cId = createdUserIds[creatorUsername];
				if (!cId) continue;

				const boostAmt = boostAmounts.get(creatorUsername) ?? 0;

				try {
					await db.insert(boostAllocations).values({
						userId,
						creatorId: cId,
						amount: boostAmt.toFixed(2),
						billingCycle: cycle,
						isLocked: false,
					});
				} catch {
					// unique constraint
				}
			}
			console.log(`    ${entries.length} boost allocations`);

			console.log(`    ${entries.length} pool distributions`);
		}

		// -- Bookmarks --
		if (tu.bookmarks.length > 0) {
			let bookmarkCount = 0;
			for (let i = 0; i < tu.bookmarks.length; i++) {
				const bm = tu.bookmarks[i];
				const values: {
					userId: number;
					sortOrder: number;
					projectId?: number;
					postId?: number;
					creatorId?: number;
				} = { userId, sortOrder: i };

				if (bm.type === "project") {
					// Former project refs are now posts (bookmarked by post).
					const postId = postIdBySlug[slugify(bm.ref)];
					if (!postId) continue;
					values.postId = postId;
				} else if (bm.type === "post") {
					const postId = postIdByTitle[bm.ref];
					if (!postId) continue;
					values.postId = postId;
				} else if (bm.type === "creator") {
					const cId = createdUserIds[bm.ref];
					if (!cId) continue;
					values.creatorId = cId;
				}

				try {
					await db.insert(bookmarks).values(values);
					bookmarkCount++;
				} catch {
					// skip duplicates
				}
			}
			console.log(`    ${bookmarkCount} bookmarks`);
		}
	}

	console.log("\nSeed complete!");
	console.log(
		`  ${CREATORS.length} creators, ${
			Object.values(PROJECTS_BY_CREATOR).flat().length +
			Object.values(POSTS_BY_CREATOR).flat().length
		} posts (works + stream), grouped into collections`,
	);
	console.log(
		`  ${TEST_USERS.length} test users (${TEST_USERS.filter((u) => u.tier !== "free").length} paid, ${TEST_USERS.filter((u) => u.tier === "free").length} free)`,
	);
	console.log(`\n  All seed accounts have password: "${SEED_PASSWORD}"`);
	console.log(`  All seed usernames start with "${SEED_PREFIX}" for easy identification.`);
	console.log("\n  Test accounts:");
	for (const tu of TEST_USERS) {
		console.log(`    ${tu.username} — ${tu.tier} tier — ${tu.displayName}`);
	}
	for (const c of CREATORS) {
		console.log(`    ${c.username} — creator — ${c.displayName}`);
	}
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isReset = args.includes("--reset");

try {
	if (isReset) {
		await cleanSeedData();
	}
	await seed();
	process.exit(0);
} catch (err) {
	console.error("Seed failed:", err);
	process.exit(1);
}
