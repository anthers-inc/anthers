from django.urls import path

from . import views

app_name = "content"

urlpatterns = [
    path("projects/", views.ProjectListCreateView.as_view(), name="project-list"),
    path("projects/<slug:slug>/", views.ProjectDetailView.as_view(), name="project-detail"),
    path("posts/", views.PostListCreateView.as_view(), name="post-list"),
    path("posts/<int:pk>/", views.PostDetailView.as_view(), name="post-detail"),
]
