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

// Protected pages
import FeedPage from "./pages/FeedPage";
import DashboardPage from "./pages/DashboardPage";
import SettingsPage from "./pages/SettingsPage";
import ProjectFormPage from "./pages/ProjectFormPage";
import BuildsPage from "./pages/BuildsPage";
import PostFormPage from "./pages/PostFormPage";

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
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

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
