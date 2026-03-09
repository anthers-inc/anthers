import math
from datetime import timedelta

from django.db.models import Avg, Count, F, Q, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework import generics, permissions, status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

import logging

from .models import Asset, Comment, InlineImage, Post, Project, Rating, Screenshot, TranscodingJob

logger = logging.getLogger(__name__)

from .serializers import (
    AssetSerializer,
    CommentSerializer,
    InlineImageSerializer,
    PostListSerializer,
    PostSerializer,
    ProjectListSerializer,
    ProjectSerializer,
    RatingAggregateSerializer,
    RatingSerializer,
    ScreenshotSerializer,
    TranscodingJobSerializer,
)


def _sync_to_atproto(record_type, obj):
    """Best-effort sync to ATProto. Logs errors but never raises."""
    try:
        from accounts.atproto_sync import (
            sync_project_to_atproto,
            sync_post_to_atproto,
            sync_rating_to_atproto,
        )
        sync_fn = {
            "project": sync_project_to_atproto,
            "post": sync_post_to_atproto,
            "rating": sync_rating_to_atproto,
        }.get(record_type)
        if sync_fn:
            sync_fn(obj)
    except Exception:
        logger.debug("ATProto sync skipped for %s %s", record_type, obj.pk, exc_info=True)


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

        # ?sort=newest|popular|top_rated|trending
        sort = self.request.query_params.get("sort", "newest")
        if sort == "popular":
            qs = qs.order_by("-view_count", "-created_at")
        elif sort == "top_rated":
            qs = qs.order_by(
                Coalesce("rating_average", 0).desc(),
                "-rating_count",
                "-created_at",
            )
        elif sort == "trending":
            # Trending: most attention events in the last 7 days
            week_ago = timezone.now() - timedelta(days=7)
            qs = qs.annotate(
                recent_attention=Coalesce(
                    Count(
                        "attention_events",
                        filter=Q(attention_events__created_at__gte=week_ago),
                    ),
                    0,
                )
            ).order_by("-recent_attention", "-view_count", "-created_at")
        elif sort == "downloads":
            qs = qs.order_by("-download_count", "-created_at")
        else:
            # Default: newest
            qs = qs.order_by("-created_at")

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
        project = serializer.save(creator=self.request.user)
        _sync_to_atproto("project", project)


class ProjectDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = ProjectSerializer
    lookup_field = "slug"

    def get_queryset(self):
        qs = Project.objects.select_related("creator", "creator__stripe_account").annotate(
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

    def retrieve(self, request, *args, **kwargs):
        instance = self.get_object()
        # Increment view count (fire-and-forget, no race-condition concern for counters)
        Project.objects.filter(pk=instance.pk).update(view_count=F("view_count") + 1)
        serializer = self.get_serializer(instance)
        return Response(serializer.data)


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


class AssetDownloadView(APIView):
    """Increment project download count and redirect to the asset file."""
    permission_classes = [permissions.AllowAny]

    def post(self, request, slug, pk):
        try:
            asset = Asset.objects.select_related("project").get(
                pk=pk, project__slug=slug
            )
        except Asset.DoesNotExist:
            return Response(
                {"detail": "Asset not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        Project.objects.filter(pk=asset.project_id).update(
            download_count=F("download_count") + 1
        )
        return Response({"url": asset.file.url})


# ─── Screenshots (nested under project) ───


class ScreenshotUploadView(generics.CreateAPIView):
    serializer_class = ScreenshotSerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        project = Project.objects.get(
            slug=self.kwargs["slug"], creator=self.request.user
        )
        serializer.save(project=project)


class ScreenshotDeleteView(generics.DestroyAPIView):
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Screenshot.objects.filter(
            project__slug=self.kwargs["slug"],
            project__creator=self.request.user,
        )


# ─── Posts ───


class PostListCreateView(generics.ListCreateAPIView):
    def get_queryset(self):
        qs = Post.objects.select_related("creator", "project").prefetch_related(
            "transcoding_jobs"
        )

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

        # ?content_type=video
        content_type = self.request.query_params.get("content_type")
        if content_type:
            qs = qs.filter(content_type=content_type)

        # ?visibility=public
        visibility = self.request.query_params.get("visibility")
        if visibility:
            qs = qs.filter(visibility=visibility)

        return qs

    def get_serializer_class(self):
        if self.request.method == "POST":
            return PostSerializer
        return PostListSerializer

    def get_permissions(self):
        if self.request.method == "POST":
            return [permissions.IsAuthenticated()]
        return [permissions.AllowAny()]

    def perform_create(self, serializer):
        post = serializer.save(creator=self.request.user)
        self._post_create_hooks(post)
        _sync_to_atproto("post", post)

    def _post_create_hooks(self, post):
        # Calculate read time for text posts
        if post.content_type == "text" and (post.body or post.body_html):
            text = post.body_html or post.body
            word_count = len(text.split())
            post.estimated_read_minutes = max(1, math.ceil(word_count / 200))
            post.save(update_fields=["estimated_read_minutes"])

        # Trigger video transcoding
        if post.content_type == "video" and post.video_file:
            from .tasks import transcode_video
            job = TranscodingJob.objects.create(
                post=post, media_type=TranscodingJob.MediaType.VIDEO
            )
            transcode_video.delay(job.id)

        # Trigger audio processing
        if post.content_type == "audio" and post.audio_file:
            from .tasks import process_audio
            job = TranscodingJob.objects.create(
                post=post, media_type=TranscodingJob.MediaType.AUDIO
            )
            process_audio.delay(job.id)


class PostDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = PostSerializer

    def get_queryset(self):
        qs = Post.objects.select_related("creator", "project").prefetch_related(
            "transcoding_jobs"
        )
        if self.request.method == "GET":
            return qs
        return qs.filter(creator=self.request.user)

    def get_permissions(self):
        if self.request.method == "GET":
            return [permissions.AllowAny()]
        return [permissions.IsAuthenticated()]

    def retrieve(self, request, *args, **kwargs):
        instance = self.get_object()
        serializer = self.get_serializer(instance)
        data = serializer.data

        # Enforce visibility restrictions on GET
        if instance.visibility != "public" and request.method == "GET":
            has_access = self._check_access(request, instance)
            data["access_granted"] = has_access
            if not has_access:
                # Redact content but keep metadata
                data["body"] = ""
                data["body_html"] = ""
                data["video_file"] = None
                data["audio_file"] = None

        return Response(data)

    def _check_access(self, request, post):
        """Check if user can view restricted content."""
        if not request.user.is_authenticated:
            return False
        if post.creator == request.user:
            return True

        from subscriptions.models import BoostAllocation, CreatorGate, Subscription
        from decimal import Decimal

        try:
            sub = request.user.subscription
        except Subscription.DoesNotExist:
            return False

        if post.visibility == "subscribers_only":
            return sub.is_paid

        if post.visibility == "gated":
            if not sub.has_gate_access:
                return False

            from django.utils import timezone as tz
            cycle_date = tz.now().date().replace(day=1)
            if sub.current_period_start:
                cycle_date = sub.current_period_start.date().replace(day=1)

            boost = BoostAllocation.objects.filter(
                user=request.user,
                creator=post.creator,
                billing_cycle=cycle_date,
            ).first()

            boost_amount = boost.amount if boost else Decimal("0.00")

            lowest_gate = CreatorGate.objects.filter(
                creator=post.creator,
            ).order_by("threshold").first()

            if lowest_gate and boost_amount >= lowest_gate.threshold:
                return True
            return False

        return True


# ─── Transcoding Status ───


class TranscodingStatusView(generics.ListAPIView):
    serializer_class = TranscodingJobSerializer
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        return TranscodingJob.objects.filter(post_id=self.kwargs["pk"])


# ─── Media Upload ───


class MediaUploadUrlView(APIView):
    """Return a presigned S3 URL (prod) or a direct upload endpoint (local dev)."""
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        from django.conf import settings as django_settings

        filename = request.data.get("filename", "upload")
        media_type = request.data.get("media_type", "video")  # video or audio

        if django_settings.STORAGE_BACKEND == "s3":
            import boto3
            from botocore.config import Config

            s3 = boto3.client(
                "s3",
                aws_access_key_id=django_settings.AWS_ACCESS_KEY_ID,
                aws_secret_access_key=django_settings.AWS_SECRET_ACCESS_KEY,
                endpoint_url=getattr(django_settings, "AWS_S3_ENDPOINT_URL", None),
                region_name=getattr(django_settings, "AWS_S3_REGION_NAME", None),
                config=Config(signature_version="s3v4"),
            )

            import uuid
            ext = filename.rsplit(".", 1)[-1] if "." in filename else ""
            key = f"{media_type}s/originals/{uuid.uuid4().hex}.{ext}"

            presigned = s3.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": django_settings.AWS_STORAGE_BUCKET_NAME,
                    "Key": key,
                },
                ExpiresIn=3600,
            )
            return Response({
                "method": "presigned",
                "upload_url": presigned,
                "storage_key": key,
            })
        else:
            return Response({
                "method": "direct",
                "upload_url": "/api/v1/content/media-upload/direct/",
                "storage_key": None,
            })


class MediaDirectUploadView(APIView):
    """Direct multipart upload fallback for local dev."""
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        uploaded = request.FILES.get("file")
        if not uploaded:
            return Response(
                {"detail": "No file provided."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        media_type = request.data.get("media_type", "video")
        from django.core.files.storage import default_storage

        import uuid
        ext = uploaded.name.rsplit(".", 1)[-1] if "." in uploaded.name else ""
        key = f"{media_type}s/originals/{uuid.uuid4().hex}.{ext}"
        saved_name = default_storage.save(key, uploaded)

        return Response({
            "storage_key": saved_name,
            "url": default_storage.url(saved_name),
        }, status=status.HTTP_201_CREATED)


# ─── Inline Images ───


class InlineImageUploadView(generics.CreateAPIView):
    serializer_class = InlineImageSerializer
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def perform_create(self, serializer):
        serializer.save(creator=self.request.user)


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
        rating, _ = Rating.objects.update_or_create(
            user=request.user,
            project=project,
            defaults={"score": serializer.validated_data["score"]},
        )
        _sync_to_atproto("rating", rating)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
