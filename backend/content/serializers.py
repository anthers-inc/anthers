from rest_framework import serializers

from .models import Asset, Post, Project


class AssetSerializer(serializers.ModelSerializer):
    class Meta:
        model = Asset
        fields = (
            "id", "project", "file", "filename", "file_size",
            "mime_type", "platform", "version", "is_primary", "created_at",
        )
        read_only_fields = ("id", "created_at")


class ProjectSerializer(serializers.ModelSerializer):
    creator = serializers.StringRelatedField(read_only=True)
    assets = AssetSerializer(many=True, read_only=True)

    class Meta:
        model = Project
        fields = (
            "id", "creator", "title", "slug", "description",
            "media_type", "tags", "is_published", "assets",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "creator", "created_at", "updated_at")


class ProjectListSerializer(serializers.ModelSerializer):
    creator = serializers.StringRelatedField(read_only=True)

    class Meta:
        model = Project
        fields = (
            "id", "creator", "title", "slug", "description",
            "media_type", "tags", "is_published",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "creator", "created_at", "updated_at")


class PostSerializer(serializers.ModelSerializer):
    creator = serializers.StringRelatedField(read_only=True)

    class Meta:
        model = Post
        fields = (
            "id", "creator", "project", "title", "body",
            "is_published", "created_at", "updated_at",
        )
        read_only_fields = ("id", "creator", "created_at", "updated_at")
