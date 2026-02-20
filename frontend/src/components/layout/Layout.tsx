import { Outlet } from "react-router-dom";

export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="navbar bg-base-200">
        <div className="flex-1">
          <a href="/" className="btn btn-ghost text-xl">
            Bluebell
          </a>
        </div>
        <div className="flex-none">
          <ul className="menu menu-horizontal px-1">
            <li>
              <a href="/explore">Explore</a>
            </li>
          </ul>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8">
        <Outlet />
      </main>

      <footer className="footer footer-center p-4 bg-base-200 text-base-content">
        <aside>
          <p>Bluebell — Creator-first, transparent, federated.</p>
        </aside>
      </footer>
    </div>
  );
}
