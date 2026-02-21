from django.db.models import Avg, Count, Q
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Asset, Comment, Post, Project, Rating
from .serializers import (
    AssetSerializer,
    CommentSerializer,
    PostSerializer,
    ProjectListSerializer,
    ProjectSerializer,
    RatingAggregateSerializer,
    RatingSerializer,
)


# ─── Projects ───


class ProjectListCreateView(generics.ListCreateAPIView):
    def get_queryset(self):
        qs = Project.objects.select_related("creator").annotate(
            rating_average=Avg("ratings__score"),
            rating_count=Count("ratings"),
        )

        # ?mine=true — show current user's projects (including drafts)
        if self.request.query_params.get("mine") == "true":
            if self.request.user.is_authenticated:
                return qs.filter(creator=self.request.user)
            return qs.none()

        # Public listing — only published
        qs = qs.filter(is_published=True)

        # ?creator=<username>
        creator = self.request.query_params.get("creator")
        if creator:
            qs = qs.filter(creator__username=creator)

        # ?media_type=game
        media_type = self.request.query_params.get("media_type")
        if media_type:
            qs = qs.filter(media_type=media_type)

        # ?tag=<tag>
        tag = self.request.query_params.get("tag")
        if tag:
            qs = qs.filter(tags__contains=[tag])

        # ?search=<query>
        search = self.request.query_params.get("search")
        if search:
            qs = qs.filter(
                Q(title__icontains=search)
                | Q(description__icontains=search)
                | Q(short_description__icontains=search)
            )

        return qs

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
        qs = Project.objects.select_related("creator").annotate(
            rating_average=Avg("ratings__score"),
            rating_count=Count("ratings"),
        )
        if self.request.method == "GET":
            return qs
        return qs.filter(creator=self.request.user)

    def get_permissions(self):
        if self.request.method == "GET":
            return [permissions.AllowAny()]
        return [permissions.IsAuthenticated()]


# ─── Assets (nested under project) ───


class AssetUploadView(generics.CreateAPIView):
    serializer_class = AssetSerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        project = Project.objects.get(
            slug=self.kwargs["slug"], creator=self.request.user
        )
        serializer.save(project=project)


class AssetDeleteView(generics.DestroyAPIView):
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Asset.objects.filter(
            project__slug=self.kwargs["slug"],
            project__creator=self.request.user,
        )


# ─── Posts ───


class PostListCreateView(generics.ListCreateAPIView):
    serializer_class = PostSerializer

    def get_queryset(self):
        qs = Post.objects.select_related("creator", "project")

        # ?mine=true
        if self.request.query_params.get("mine") == "true":
            if self.request.user.is_authenticated:
                return qs.filter(creator=self.request.user)
            return qs.none()

        # Public — only published
        qs = qs.filter(is_published=True)

        # ?creator=<username>
        creator = self.request.query_params.get("creator")
        if creator:
            qs = qs.filter(creator__username=creator)

        # ?project=<slug>
        project_slug = self.request.query_params.get("project")
        if project_slug:
            qs = qs.filter(project__slug=project_slug)

        return qs

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
            return Post.objects.select_related("creator", "project")
        return Post.objects.filter(creator=self.request.user)

    def get_permissions(self):
        if self.request.method == "GET":
            return [permissions.AllowAny()]
        return [permissions.IsAuthenticated()]


# ─── Comments (nested under project or post) ───


class ProjectCommentListCreateView(generics.ListCreateAPIView):
    serializer_class = CommentSerializer

    def get_queryset(self):
        return Comment.objects.filter(
            project__slug=self.kwargs["slug"]
        ).select_related("user")

    def get_permissions(self):
        if self.request.method == "POST":
            return [permissions.IsAuthenticated()]
        return [permissions.AllowAny()]

    def perform_create(self, serializer):
        project = Project.objects.get(slug=self.kwargs["slug"])
        serializer.save(user=self.request.user, project=project)


class PostCommentListCreateView(generics.ListCreateAPIView):
    serializer_class = CommentSerializer

    def get_queryset(self):
        return Comment.objects.filter(
            post_id=self.kwargs["pk"]
        ).select_related("user")

    def get_permissions(self):
        if self.request.method == "POST":
            return [permissions.IsAuthenticated()]
        return [permissions.AllowAny()]

    def perform_create(self, serializer):
        post = Post.objects.get(pk=self.kwargs["pk"])
        serializer.save(user=self.request.user, post=post)


# ─── Ratings (nested under project) ───


class ProjectRatingView(APIView):
    """GET: aggregate rating. POST: rate a project (1-5)."""

    def get_permissions(self):
        if self.request.method == "POST":
            return [permissions.IsAuthenticated()]
        return [permissions.AllowAny()]

    def get(self, request, slug):
        agg = Rating.objects.filter(project__slug=slug).aggregate(
            average=Avg("score"),
            count=Count("id"),
        )
        user_rating = None
        if request.user.is_authenticated:
            rating = Rating.objects.filter(
                project__slug=slug, user=request.user
            ).first()
            if rating:
                user_rating = rating.score
        agg["user_rating"] = user_rating
        return Response(RatingAggregateSerializer(agg).data)

    def post(self, request, slug):
        try:
            project = Project.objects.get(slug=slug)
        except Project.DoesNotExist:
            return Response(
                {"detail": "Project not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        serializer = RatingSerializer(data={
            "project": project.pk,
            "score": request.data.get("score"),
        })
        serializer.is_valid(raise_exception=True)
        # Upsert — update if already rated
        Rating.objects.update_or_create(
            user=request.user,
            project=project,
            defaults={"score": serializer.validated_data["score"]},
        )
        return Response(serializer.data, status=status.HTTP_201_CREATED)
