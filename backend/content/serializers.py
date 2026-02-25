from rest_framework import serializers

from .models import (
    Asset, Comment, InlineImage, Post, Project, Rating, Screenshot,
    TranscodingJob,
)


class ScreenshotSerializer(serializers.ModelSerializer):
    class Meta:
        model = Screenshot
        fields = ("id", "image", "caption", "sort_order", "created_at")
        read_only_fields = ("id", "created_at")


class AssetSerializer(serializers.ModelSerializer):
    class Meta:
        model = Asset
        fields = (
            "id", "project", "file", "filename", "file_size",
            "mime_type", "platform", "version", "is_primary", "created_at",
        )
        read_only_fields = ("id", "created_at")


class CommentSerializer(serializers.ModelSerializer):
    user = serializers.StringRelatedField(read_only=True)
    username = serializers.CharField(source="user.username", read_only=True)
    avatar = serializers.ImageField(source="user.avatar", read_only=True)

    class Meta:
        model = Comment
        fields = (
            "id", "user", "username", "avatar", "project", "post",
            "body", "created_at",
        )
        read_only_fields = ("id", "user", "username", "avatar", "created_at")


class RatingSerializer(serializers.ModelSerializer):
    class Meta:
        model = Rating
        fields = ("id", "user", "project", "score", "created_at")
        read_only_fields = ("id", "user", "created_at")


class RatingAggregateSerializer(serializers.Serializer):
    average = serializers.FloatField()
    count = serializers.IntegerField()
    user_rating = serializers.IntegerField(allow_null=True)


class ProjectSerializer(serializers.ModelSerializer):
    creator = serializers.StringRelatedField(read_only=True)
    creator_id = serializers.IntegerField(source="creator.pk", read_only=True)
    creator_username = serializers.CharField(source="creator.username", read_only=True)
    assets = AssetSerializer(many=True, read_only=True)
    screenshots = ScreenshotSerializer(many=True, read_only=True)
    rating_average = serializers.FloatField(read_only=True, default=None)
    rating_count = serializers.IntegerField(read_only=True, default=0)
    creator_has_stripe = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = (
            "id", "creator", "creator_id", "creator_username", "title", "slug",
            "description", "short_description",
            "media_type", "tags", "is_published",
            "pricing_type", "price", "min_price", "suggested_price",
            "cover_image", "embed_url",
            "website_url", "source_url",
            "assets", "screenshots",
            "rating_average", "rating_count",
            "view_count", "download_count",
            "creator_has_stripe",
            "created_at", "updated_at",
        )
        read_only_fields = (
            "id", "creator", "creator_id", "creator_username",
            "rating_average", "rating_count",
            "view_count", "download_count",
            "creator_has_stripe",
            "created_at", "updated_at",
        )

    def get_creator_has_stripe(self, obj):
        stripe_account = getattr(obj.creator, "stripe_account", None)
        return stripe_account is not None and stripe_account.charges_enabled


class ProjectListSerializer(serializers.ModelSerializer):
    creator = serializers.StringRelatedField(read_only=True)
    creator_id = serializers.IntegerField(source="creator.pk", read_only=True)
    creator_username = serializers.CharField(source="creator.username", read_only=True)
    rating_average = serializers.FloatField(read_only=True, default=None)
    rating_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Project
        fields = (
            "id", "creator", "creator_id", "creator_username", "title", "slug",
            "short_description", "media_type", "tags", "is_published",
            "pricing_type", "price", "min_price", "suggested_price",
            "cover_image",
            "rating_average", "rating_count",
            "view_count", "download_count",
            "created_at", "updated_at",
        )
        read_only_fields = (
            "id", "creator", "creator_id", "creator_username",
            "rating_average", "rating_count",
            "view_count", "download_count",
            "created_at", "updated_at",
        )


# ─── Transcoding ───


class TranscodingJobSerializer(serializers.ModelSerializer):
    class Meta:
        model = TranscodingJob
        fields = (
            "id", "post", "media_type", "status", "progress",
            "error_message", "hls_manifest_url", "output_file_url",
            "waveform_data", "created_at", "updated_at",
        )
        read_only_fields = fields


# ─── Posts ───


class PostSerializer(serializers.ModelSerializer):
    creator = serializers.StringRelatedField(read_only=True)
    creator_id = serializers.IntegerField(source="creator.pk", read_only=True)
    creator_username = serializers.CharField(source="creator.username", read_only=True)
    creator_avatar = serializers.ImageField(source="creator.avatar", read_only=True)
    project_title = serializers.CharField(source="project.title", read_only=True, default=None)
    project_slug = serializers.CharField(source="project.slug", read_only=True, default=None)
    transcoding_jobs = TranscodingJobSerializer(many=True, read_only=True)

    class Meta:
        model = Post
        fields = (
            "id", "creator", "creator_id", "creator_username", "creator_avatar",
            "project", "project_title", "project_slug",
            "title", "body", "body_html", "content_type",
            "video_file", "audio_file", "thumbnail",
            "duration_seconds", "is_premium", "visibility",
            "is_published", "estimated_read_minutes",
            "transcoding_jobs",
            "created_at", "updated_at",
        )
        read_only_fields = (
            "id", "creator", "creator_id", "creator_username", "creator_avatar",
            "project_title", "project_slug",
            "duration_seconds", "estimated_read_minutes",
            "transcoding_jobs",
            "created_at", "updated_at",
        )


class PostListSerializer(serializers.ModelSerializer):
    creator = serializers.StringRelatedField(read_only=True)
    creator_id = serializers.IntegerField(source="creator.pk", read_only=True)
    creator_username = serializers.CharField(source="creator.username", read_only=True)
    creator_avatar = serializers.ImageField(source="creator.avatar", read_only=True)
    project_title = serializers.CharField(source="project.title", read_only=True, default=None)
    project_slug = serializers.CharField(source="project.slug", read_only=True, default=None)
    latest_transcoding_status = serializers.SerializerMethodField()

    class Meta:
        model = Post
        fields = (
            "id", "creator", "creator_id", "creator_username", "creator_avatar",
            "project", "project_title", "project_slug",
            "title", "content_type", "thumbnail",
            "duration_seconds", "is_premium", "visibility",
            "is_published", "estimated_read_minutes",
            "latest_transcoding_status",
            "created_at", "updated_at",
        )
        read_only_fields = fields

    def get_latest_transcoding_status(self, obj):
        job = obj.transcoding_jobs.first()
        if job:
            return {"status": job.status, "progress": job.progress}
        return None


class InlineImageSerializer(serializers.ModelSerializer):
    class Meta:
        model = InlineImage
        fields = ("id", "image", "created_at")
        read_only_fields = ("id", "created_at")
