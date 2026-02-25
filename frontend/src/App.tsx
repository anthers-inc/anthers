import { Routes, Route } from "react-router-dom";
import Layout from "./components/layout/Layout";
import ProtectedRoute from "./components/ui/ProtectedRoute";

// Public pages
import HomePage from "./pages/HomePage";
import ForCreatorsPage from "./pages/ForCreatorsPage";
import ForUsersPage from "./pages/ForUsersPage";
import ExplorePage from "./pages/ExplorePage";
import ProjectPage from "./pages/ProjectPage";
import PostFeedPage from "./pages/PostFeedPage";
import PostPage from "./pages/PostPage";
import CreatorsPage from "./pages/CreatorsPage";
import CreatorProfilePage from "./pages/CreatorProfilePage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ATProtoCallbackPage from "./pages/ATProtoCallbackPage";
import JamsPage from "./pages/JamsPage";
import JamPage from "./pages/JamPage";

// Protected pages
import FeedPage from "./pages/FeedPage";
import DashboardPage from "./pages/DashboardPage";
import SettingsPage from "./pages/SettingsPage";
import ProjectFormPage from "./pages/ProjectFormPage";
import BuildsPage from "./pages/BuildsPage";
import PostFormPage from "./pages/PostFormPage";
import LibraryPage from "./pages/LibraryPage";
import SubscribePage from "./pages/SubscribePage";
import SubscriptionPage from "./pages/SubscriptionPage";
import AnalyticsDashboardPage from "./pages/AnalyticsDashboardPage";
import JamFormPage from "./pages/JamFormPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        {/* Public routes */}
        <Route path="/" element={<HomePage />} />
        <Route path="/for-creators" element={<ForCreatorsPage />} />
        <Route path="/for-users" element={<ForUsersPage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/explore/:slug" element={<ProjectPage />} />
        <Route path="/posts" element={<PostFeedPage />} />
        <Route path="/posts/:id" element={<PostPage />} />
        <Route path="/creators" element={<CreatorsPage />} />
        <Route path="/subscribe" element={<SubscribePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/auth/atproto/callback" element={<ATProtoCallbackPage />} />
        <Route path="/jams" element={<JamsPage />} />
        <Route path="/jams/:slug" element={<JamPage />} />

        {/* Protected routes */}
        <Route
          path="/feed"
          element={
            <ProtectedRoute>
              <FeedPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/projects/new"
          element={
            <ProtectedRoute>
              <ProjectFormPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/projects/:slug/edit"
          element={
            <ProtectedRoute>
              <ProjectFormPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/projects/:slug/builds"
          element={
            <ProtectedRoute>
              <BuildsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/posts/new"
          element={
            <ProtectedRoute>
              <PostFormPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/posts/:id/edit"
          element={
            <ProtectedRoute>
              <PostFormPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/jams/new"
          element={
            <ProtectedRoute>
              <JamFormPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/jams/:slug/edit"
          element={
            <ProtectedRoute>
              <JamFormPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/analytics"
          element={
            <ProtectedRoute>
              <AnalyticsDashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/library"
          element={
            <ProtectedRoute>
              <LibraryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/subscription"
          element={
            <ProtectedRoute>
              <SubscriptionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />

        {/* Creator profile — must be last to avoid catching other routes */}
        <Route path="/:username" element={<CreatorProfilePage />} />
      </Route>
    </Routes>
  );
}
