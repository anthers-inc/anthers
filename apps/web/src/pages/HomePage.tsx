// SPDX-License-Identifier: AGPL-3.0-or-later
import { PaintBrushIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import CreatorCard from "../components/cards/CreatorCard";
import PostCard from "../components/cards/PostCard";
import ProjectCard from "../components/cards/ProjectCard";
import { client } from "../lib/rpc";
import type { PostListItem, Project, PublicUser } from "../lib/types";

export default function HomePage() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [creators, setCreators] = useState<PublicUser[]>([]);

	useEffect(() => {
		client.api.content.projects
			.$get()
			.then((res) => res.json())
			.then((data) => setProjects(data.projects.slice(0, 8)))
			.catch(() => {});
		client.api.content.posts
			.$get()
			.then((res) => res.json())
			.then((data) => setPosts(data.posts.slice(0, 4)))
			.catch(() => {});
		client.api.accounts.creators
			.$get()
			.then((res) => res.json())
			.then((data) => setCreators(data.creators.slice(0, 4)))
			.catch(() => {});
	}, []);

	return (
		<div>
			{/* Hero */}
			<section className="hero min-h-[85vh]">
				<div className="hero-content text-center py-20">
					<div className="max-w-3xl">
						<h1 className="text-6xl font-bold tracking-tight">Anthers</h1>
						<p className="py-6 text-xl text-base-content/70 leading-relaxed max-w-2xl mx-auto">
							A home for creators and the people who love their work. Publish games, videos, music,
							and writing—or discover your next favorite thing.
						</p>

						<div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-xl mx-auto mt-8">
							<Link
								to="/for-creators"
								className="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer"
							>
								<div className="card-body items-center text-center py-8">
									<div className="w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center mb-2">
										<PaintBrushIcon className="w-7 h-7 text-primary" />
									</div>
									<h2 className="card-title text-lg">For Creators</h2>
									<p className="text-sm text-base-content/60">
										Publish your work. Keep 100% of your earnings. Build your audience in one place.
									</p>
									<span className="btn btn-primary btn-sm mt-2">Learn more</span>
								</div>
							</Link>

							<Link
								to="/for-users"
								className="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer"
							>
								<div className="card-body items-center text-center py-8">
									<div className="w-14 h-14 rounded-full bg-secondary/15 flex items-center justify-center mb-2">
										<SparklesIcon className="w-7 h-7 text-secondary" />
									</div>
									<h2 className="card-title text-lg">For Users</h2>
									<p className="text-sm text-base-content/60">
										Discover games, music, videos, and writing. Play in your browser. Support
										creators directly.
									</p>
									<span className="btn btn-secondary btn-sm mt-2">Learn more</span>
								</div>
							</Link>
						</div>

						<div className="flex gap-4 justify-center flex-wrap mt-10">
							<Link to="/discover" className="btn btn-ghost btn-sm">
								Browse projects →
							</Link>
						</div>

						<p className="mt-8 text-sm text-base-content/40">
							Free to use. No hidden fees. No platform cut.
						</p>
					</div>
				</div>
			</section>

			{/* Featured Projects */}
			{projects.length > 0 && (
				<section className="py-16 px-4">
					<div className="max-w-7xl mx-auto">
						<div className="flex items-center justify-between mb-6">
							<h2 className="text-2xl font-bold">Featured Projects</h2>
							<Link to="/discover" className="btn btn-ghost btn-sm">
								View all →
							</Link>
						</div>
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
							{projects.map((p) => (
								<ProjectCard key={p.id} project={p} />
							))}
						</div>
					</div>
				</section>
			)}

			{/* Recent Posts */}
			{posts.length > 0 && (
				<section className="py-16 px-4 bg-base-200/50">
					<div className="max-w-7xl mx-auto">
						<div className="flex items-center justify-between mb-6">
							<h2 className="text-2xl font-bold">Recent Posts</h2>
							<Link to="/discover" className="btn btn-ghost btn-sm">
								View all →
							</Link>
						</div>
						<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
							{posts.map((p) => (
								<PostCard key={p.id} post={p} />
							))}
						</div>
					</div>
				</section>
			)}

			{/* Featured Creators */}
			{creators.length > 0 && (
				<section className="py-16 px-4">
					<div className="max-w-7xl mx-auto">
						<div className="flex items-center justify-between mb-6">
							<h2 className="text-2xl font-bold">Featured Creators</h2>
							<Link to="/discover" className="btn btn-ghost btn-sm">
								View all →
							</Link>
						</div>
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
							{creators.map((c) => (
								<CreatorCard key={c.id} creator={c} />
							))}
						</div>
					</div>
				</section>
			)}
		</div>
	);
}
