import { useAuth } from "../../lib/auth";
import LoggedInLayout from "./LoggedInLayout";
import LoggedOutLayout from "./LoggedOutLayout";
import LoadingSpinner from "../ui/LoadingSpinner";

/**
 * Auth-aware layout switcher.
 * Renders LoggedInLayout for authenticated users, LoggedOutLayout otherwise.
 * Used for shared routes (explore, creators, posts, etc.) that should work
 * for both logged-in and logged-out users but with the appropriate chrome.
 */
export default function Layout() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return isAuthenticated ? <LoggedInLayout /> : <LoggedOutLayout />;
}
