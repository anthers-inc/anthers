import { Routes, Route } from "react-router-dom";
import Layout from "./components/layout/Layout";

// Pages
import HomePage from "./pages/HomePage";
import ExplorePage from "./pages/ExplorePage";
import ProjectPage from "./pages/ProjectPage";
import PostFeedPage from "./pages/PostFeedPage";
import PostPage from "./pages/PostPage";
import CreatorsPage from "./pages/CreatorsPage";
import CreatorProfilePage from "./pages/CreatorProfilePage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        {/* Public routes */}
        <Route path="/" element={<HomePage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/explore/:slug" element={<ProjectPage />} />
        <Route path="/posts" element={<PostFeedPage />} />
        <Route path="/posts/:id" element={<PostPage />} />
        <Route path="/creators" element={<CreatorsPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Creator profile — must be last to avoid catching other routes */}
        <Route path="/:username" element={<CreatorProfilePage />} />
      </Route>
    </Routes>
  );
}
