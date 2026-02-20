from rest_framework import generics, permissions

from .models import Post, Project
from .serializers import PostSerializer, ProjectListSerializer, ProjectSerializer


class ProjectListCreateView(generics.ListCreateAPIView):
    queryset = Project.objects.filter(is_published=True)

    def get_serializer_class(self):
        if self.request.method == "POST":
            return ProjectSerializer
        return ProjectListSerializer

    def get_permissions(self):
        if self.request.method == "POST":
            return [permissions.IsAuthenticated()]
        return [permissions.AllowAny()]

    def perform_create(self, serializer):
        serializer.save(creator=self.request.user)


class ProjectDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = ProjectSerializer
    lookup_field = "slug"

    def get_queryset(self):
        if self.request.method == "GET":
            return Project.objects.all()
        return Project.objects.filter(creator=self.request.user)

    def get_permissions(self):
        if self.request.method == "GET":
            return [permissions.AllowAny()]
        return [permissions.IsAuthenticated()]


class PostListCreateView(generics.ListCreateAPIView):
    serializer_class = PostSerializer
    queryset = Post.objects.filter(is_published=True)

    def get_permissions(self):
        if self.request.method == "POST":
            return [permissions.IsAuthenticated()]
        return [permissions.AllowAny()]

    def perform_create(self, serializer):
        serializer.save(creator=self.request.user)


class PostDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = PostSerializer

    def get_queryset(self):
        if self.request.method == "GET":
            return Post.objects.all()
        return Post.objects.filter(creator=self.request.user)

    def get_permissions(self):
        if self.request.method == "GET":
            return [permissions.AllowAny()]
        return [permissions.IsAuthenticated()]
