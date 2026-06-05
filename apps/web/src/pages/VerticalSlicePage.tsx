// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { client } from "../lib/rpc";

type User = {
	id: number;
	username: string;
	email: string;
	displayName: string | null;
	isCreator: boolean | null;
};

type Project = {
	id: number;
	title: string;
	slug: string;
	description: string | null;
	pricingModel: string;
	createdAt: string;
};

export default function VerticalSlicePage() {
	const [user, setUser] = useState<User | null>(null);
	const [projects, setProjects] = useState<Project[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	// Auth form state
	const [username, setUsername] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	// Project form state
	const [title, setTitle] = useState("");
	const [slug, setSlug] = useState("");
	const [description, setDescription] = useState("");

	const handleSignUp = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setLoading(true);
		try {
			const res = await client.api.auth["sign-up"].$post({
				json: { username, email, password },
			});
			if (!res.ok) {
				const data = await res.json();
				setError("error" in data ? (data as any).error : "Sign up failed");
				return;
			}
			const data = await res.json();
			setUser(data.user);
			await loadProjects();
		} catch (err) {
			setError(String(err));
		} finally {
			setLoading(false);
		}
	};

	const handleSignIn = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setLoading(true);
		try {
			const res = await client.api.auth["sign-in"].$post({
				json: { username, password },
			});
			if (!res.ok) {
				const data = await res.json();
				setError("error" in data ? (data as any).error : "Sign in failed");
				return;
			}
			const data = await res.json();
			setUser(data.user);
			await loadProjects();
		} catch (err) {
			setError(String(err));
		} finally {
			setLoading(false);
		}
	};

	const handleSignOut = async () => {
		await client.api.auth["sign-out"].$post();
		setUser(null);
	};

	const loadProjects = async () => {
		const res = await client.api.projects.$get();
		if (res.ok) {
			const data = await res.json();
			setProjects(data.projects as Project[]);
		}
	};

	const handleCreateProject = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setLoading(true);
		try {
			const res = await client.api.projects.$post({
				json: { title, slug, description },
			});
			if (!res.ok) {
				const data = await res.json();
				setError("error" in data ? (data as any).error : "Create failed");
				return;
			}
			setTitle("");
			setSlug("");
			setDescription("");
			await loadProjects();
		} catch (err) {
			setError(String(err));
		} finally {
			setLoading(false);
		}
	};

	const checkMe = async () => {
		const res = await client.api.auth.me.$get();
		if (res.ok) {
			const data = await res.json();
			setUser(data.user);
			if (data.user) await loadProjects();
		}
	};

	return (
		<div className="min-h-screen bg-base-200 p-8">
			<div className="max-w-2xl mx-auto space-y-6">
				<h1 className="text-3xl font-bold">Vertical Slice Test</h1>
				<p className="text-base-content/70">
					End-to-end proof: React &rarr; Hono RPC &rarr; Zod &rarr; Drizzle &rarr; PostgreSQL
				</p>

				{error && (
					<div className="alert alert-error">
						<span>{error}</span>
					</div>
				)}

				{!user ? (
					<div className="card bg-base-100 shadow">
						<div className="card-body">
							<h2 className="card-title">Sign Up / Sign In</h2>
							<div className="space-y-4">
								<input
									type="text"
									placeholder="Username"
									className="input input-bordered w-full"
									value={username}
									onChange={(e) => setUsername(e.target.value)}
								/>
								<input
									type="email"
									placeholder="Email (sign-up only)"
									className="input input-bordered w-full"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
								<input
									type="password"
									placeholder="Password"
									className="input input-bordered w-full"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
								/>
								<div className="flex gap-2">
									<button
										type="button"
										className="btn btn-primary"
										onClick={handleSignUp}
										disabled={loading}
									>
										Sign Up
									</button>
									<button
										type="button"
										className="btn btn-secondary"
										onClick={handleSignIn}
										disabled={loading}
									>
										Sign In
									</button>
									<button type="button" className="btn btn-ghost" onClick={checkMe}>
										Check Session
									</button>
								</div>
							</div>
						</div>
					</div>
				) : (
					<>
						<div className="card bg-base-100 shadow">
							<div className="card-body">
								<div className="flex justify-between items-center">
									<div>
										<h2 className="card-title">Signed in as {user.username}</h2>
										<p className="text-sm text-base-content/70">{user.email}</p>
									</div>
									<button type="button" className="btn btn-ghost btn-sm" onClick={handleSignOut}>
										Sign Out
									</button>
								</div>
							</div>
						</div>

						<div className="card bg-base-100 shadow">
							<div className="card-body">
								<h2 className="card-title">Create Project</h2>
								<form onSubmit={handleCreateProject} className="space-y-4">
									<input
										type="text"
										placeholder="Project Title"
										className="input input-bordered w-full"
										value={title}
										onChange={(e) => setTitle(e.target.value)}
										required
									/>
									<input
										type="text"
										placeholder="slug-like-this"
										className="input input-bordered w-full"
										value={slug}
										onChange={(e) => setSlug(e.target.value)}
										required
									/>
									<textarea
										placeholder="Description"
										className="textarea textarea-bordered w-full"
										value={description}
										onChange={(e) => setDescription(e.target.value)}
									/>
									<button type="submit" className="btn btn-primary" disabled={loading}>
										Create Project
									</button>
								</form>
							</div>
						</div>

						{projects.length > 0 && (
							<div className="card bg-base-100 shadow">
								<div className="card-body">
									<h2 className="card-title">Projects</h2>
									<div className="space-y-2">
										{projects.map((p) => (
											<div key={p.id} className="p-3 bg-base-200 rounded-lg">
												<div className="font-semibold">{p.title}</div>
												<div className="text-sm text-base-content/70">
													/{p.slug} &middot; {p.pricingModel}
												</div>
												{p.description && <div className="text-sm mt-1">{p.description}</div>}
											</div>
										))}
									</div>
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
