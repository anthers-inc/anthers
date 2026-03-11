import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import FormField from "../components/ui/FormField";

export default function LoginPage() {
  const { signIn, signInWithBluesky } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? "/feed";

  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Bluesky login state
  const [bskyHandle, setBskyHandle] = useState("");
  const [bskyLoading, setBskyLoading] = useState(false);
  const [bskyError, setBskyError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signIn(login, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleBlueskyLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bskyHandle.trim()) return;
    setBskyError("");
    setBskyLoading(true);
    try {
      await signInWithBluesky(bskyHandle.trim());
      // signInWithBluesky redirects, so we won't reach here
    } catch (err) {
      setBskyError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setBskyLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-md">
      <div className="card bg-base-200 shadow-lg">
        <div className="card-body">
          <h1 className="card-title text-2xl justify-center">Log in</h1>

          {/* Bluesky Sign In */}
          <form onSubmit={handleBlueskyLogin} className="flex flex-col gap-3">
            {bskyError && (
              <div className="alert alert-error text-sm">
                <span>{bskyError}</span>
              </div>
            )}
            <FormField label="Bluesky Handle">
              <input
                type="text"
                className="input input-bordered w-full"
                value={bskyHandle}
                onChange={(e) => setBskyHandle(e.target.value)}
                placeholder="alice.bsky.social"
              />
            </FormField>
            <button
              type="submit"
              className="btn btn-outline w-full"
              disabled={bskyLoading || !bskyHandle.trim()}
            >
              {bskyLoading ? (
                <span className="loading loading-spinner loading-sm" />
              ) : (
                <>
                  <svg
                    viewBox="0 0 568 501"
                    className="w-4 h-4 fill-current"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path d="M123.121 33.6637C188.241 82.5526 258.281 181.681 284 234.873C309.719 181.681 379.759 82.5526 444.879 33.6637C491.866 -1.61183 568 -28.9064 568 57.9464C568 75.2916 558.055 189.32 552 210.074C529.348 289.699 445.566 310.618 370.792 297.604C496.333 319.1 526.542 386.3 468.333 453.5C356.973 581.793 299.832 402.163 287.455 359.379C285.755 353.725 284.024 353.712 282.545 359.379C270.168 402.163 213.027 581.793 101.667 453.5C43.4583 386.3 73.6667 319.1 199.208 297.604C124.434 310.618 40.652 289.699 18 210.074C11.945 189.32 2 75.2916 2 57.9464C2 -28.9064 78.1345 -1.61183 123.121 33.6637Z" />
                  </svg>
                  Sign in with Bluesky
                </>
              )}
            </button>
          </form>

          <div className="divider text-xs text-base-content/40">OR</div>

          {/* Traditional Login */}
          {error && (
            <div className="alert alert-error text-sm">
              <span>{error}</span>
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <FormField label="Username or Email" required>
              <input
                type="text"
                className="input input-bordered w-full"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                required
              />
            </FormField>
            <FormField label="Password" required>
              <input
                type="password"
                className="input input-bordered w-full"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </FormField>
            <button
              type="submit"
              className="btn btn-primary w-full mt-2"
              disabled={loading}
            >
              {loading ? <span className="loading loading-spinner loading-sm" /> : "Log in"}
            </button>
          </form>
          <p className="text-center text-sm mt-4">
            Don't have an account?{" "}
            <Link to="/register" className="link link-primary">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
