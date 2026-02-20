export default function HomePage() {
  return (
    <div className="hero min-h-[60vh]">
      <div className="hero-content text-center">
        <div className="max-w-2xl">
          <h1 className="text-5xl font-bold">Bluebell</h1>
          <p className="py-6 text-lg text-base-content/70">
            A creator-first media platform. Share games, videos, music, and
            writing — keep 100% of your earnings.
          </p>
          <div className="flex gap-4 justify-center">
            <button className="btn btn-primary">Explore</button>
            <button className="btn btn-outline">Create</button>
          </div>
        </div>
      </div>
    </div>
  );
}
