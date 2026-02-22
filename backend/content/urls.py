from django.urls import path

from . import views

app_name = "content"

urlpatterns = [
    # Projects
    path("projects/", views.ProjectListCreateView.as_view(), name="project-list"),
    path("projects/<slug:slug>/", views.ProjectDetailView.as_view(), name="project-detail"),
    # Assets (nested under project)
    path("projects/<slug:slug>/assets/", views.AssetUploadView.as_view(), name="asset-upload"),
    path("projects/<slug:slug>/assets/<int:pk>/", views.AssetDeleteView.as_view(), name="asset-delete"),
    # Screenshots (nested under project)
    path("projects/<slug:slug>/screenshots/", views.ScreenshotUploadView.as_view(), name="screenshot-upload"),
    path("projects/<slug:slug>/screenshots/<int:pk>/", views.ScreenshotDeleteView.as_view(), name="screenshot-delete"),
    # Comments on projects
    path("projects/<slug:slug>/comments/", views.ProjectCommentListCreateView.as_view(), name="project-comments"),
    # Ratings on projects
    path("projects/<slug:slug>/ratings/", views.ProjectRatingView.as_view(), name="project-ratings"),
    # Posts
    path("posts/", views.PostListCreateView.as_view(), name="post-list"),
    path("posts/<int:pk>/", views.PostDetailView.as_view(), name="post-detail"),
    # Comments on posts
    path("posts/<int:pk>/comments/", views.PostCommentListCreateView.as_view(), name="post-comments"),
]
