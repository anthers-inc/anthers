from rest_framework import serializers

from .models import CrossPublishResult, ExternalMetricSnapshot, PlatformConnection


class PlatformConnectionSerializer(serializers.ModelSerializer):
    platform_display = serializers.CharField(
        source="get_platform_display", read_only=True
    )

    class Meta:
        model = PlatformConnection
        fields = [
            "id",
            "platform",
            "platform_display",
            "platform_user_id",
            "platform_username",
            "is_active",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "platform_user_id",
            "platform_username",
            "created_at",
            "updated_at",
        ]


class PlatformConnectionCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = PlatformConnection
        fields = ["platform", "api_key"]

    def validate_platform(self, value):
        user = self.context["request"].user
        if PlatformConnection.objects.filter(user=user, platform=value).exists():
            raise serializers.ValidationError(
                f"You already have a {value} connection. Disconnect it first."
            )
        return value


class CrossPublishResultSerializer(serializers.ModelSerializer):
    platform_display = serializers.CharField(
        source="get_platform_display", read_only=True
    )
    content_title = serializers.SerializerMethodField()
    content_type = serializers.SerializerMethodField()

    class Meta:
        model = CrossPublishResult
        fields = [
            "id",
            "platform",
            "platform_display",
            "content_title",
            "content_type",
            "external_id",
            "external_url",
            "status",
            "error_message",
            "published_at",
            "created_at",
        ]

    def get_content_title(self, obj):
        if obj.project:
            return obj.project.title
        if obj.post:
            return obj.post.title or f"Post #{obj.post.pk}"
        return None

    def get_content_type(self, obj):
        if obj.project:
            return "project"
        if obj.post:
            return "post"
        return None


class ExternalMetricSnapshotSerializer(serializers.ModelSerializer):
    class Meta:
        model = ExternalMetricSnapshot
        fields = [
            "id",
            "views",
            "likes",
            "comments",
            "shares",
            "watch_time_seconds",
            "revenue_cents",
            "snapshot_date",
        ]
