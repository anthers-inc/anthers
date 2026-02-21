import { Link } from "react-router-dom";
import {
  PaintBrushIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";

export default function HomePage() {
  return (
    <div>
      {/* ───────────── Hero ───────────── */}
      <section className="hero min-h-[85vh] bg-gradient-to-b from-base-200 to-base-100">
        <div className="hero-content text-center py-20">
          <div className="max-w-3xl">
            <h1 className="text-6xl font-bold tracking-tight">Bluebell</h1>
            <p className="py-6 text-xl text-base-content/70 leading-relaxed max-w-2xl mx-auto">
              A home for creators and the people who love their work. Publish
              games, videos, music, and writing — or discover your next
              favorite thing.
            </p>

            {/* Two side-by-side CTAs */}
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
                    Publish your work. Keep 100% of your earnings. Build your
                    audience in one place.
                  </p>
                  <span className="btn btn-primary btn-sm mt-2">
                    Learn more
                  </span>
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
                    Discover games, music, videos, and writing. Play in your
                    browser. Support creators directly.
                  </p>
                  <span className="btn btn-secondary btn-sm mt-2">
                    Learn more
                  </span>
                </div>
              </Link>
            </div>

            <div className="flex gap-4 justify-center flex-wrap mt-10">
              <Link to="/explore" className="btn btn-ghost btn-sm">
                Browse projects →
              </Link>
            </div>

            <p className="mt-8 text-sm text-base-content/40">
              Free to use. No hidden fees. No platform cut.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
