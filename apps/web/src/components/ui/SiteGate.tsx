import { useState, type ReactNode } from "react";
import { BASE_URL } from "../../lib/api";

const STORAGE_KEY = "bluebell_site_access";
const GATE_URL = BASE_URL + "/health/gate/";

export default function SiteGate({ children }: { children: ReactNode }) {
  const [authorized, setAuthorized] = useState(
    () => localStorage.getItem(STORAGE_KEY) === "true"
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  if (authorized) return <>{children}</>;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(GATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        localStorage.setItem(STORAGE_KEY, "true");
        setAuthorized(true);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-base-200">
      <form
        onSubmit={handleSubmit}
        className="card bg-base-100 shadow-xl p-8 w-full max-w-sm"
      >
        <h1 className="text-2xl font-bold text-center mb-2">Bluebell</h1>
        <p className="text-center text-base-content/60 mb-6">
          This site is currently in development. Enter the password to continue.
        </p>
        <input
          type="password"
          className={`input input-bordered w-full mb-3 ${error ? "input-error" : ""}`}
          placeholder="Password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(false);
          }}
          autoFocus
        />
        {error && (
          <p className="text-error text-sm mb-3">Incorrect password.</p>
        )}
        <button type="submit" className="btn btn-primary w-full" disabled={loading}>
          {loading ? "Checking..." : "Enter"}
        </button>
      </form>
    </div>
  );
}
