from django.contrib import admin

from .models import (
    Asset, Comment, InlineImage, Post, Project, Rating, Screenshot,
    TranscodingJob,
)


class AssetInline(admin.TabularInline):
    model = Asset
    extra = 0


class ScreenshotInline(admin.TabularInline):
    model = Screenshot
    extra = 0


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = (
        "title", "creator", "media_type", "pricing_type",
        "is_published", "created_at",
    )
    list_filter = ("media_type", "pricing_type", "is_published")
    search_fields = ("title", "slug", "creator__username")
    prepopulated_fields = {"slug": ("title",)}
    inlines = [ScreenshotInline, AssetInline]


@admin.register(Screenshot)
class ScreenshotAdmin(admin.ModelAdmin):
    list_display = ("project", "caption", "sort_order", "created_at")
    list_filter = ("project",)


@admin.register(Asset)
class AssetAdmin(admin.ModelAdmin):
    list_display = ("filename", "project", "mime_type", "file_size", "is_primary", "created_at")
    list_filter = ("is_primary", "platform")


@admin.register(Post)
class PostAdmin(admin.ModelAdmin):
    list_display = (
        "title", "creator", "content_type", "visibility",
        "project", "is_published", "created_at",
    )
    list_filter = ("content_type", "visibility", "is_published", "is_premium")
    search_fields = ("title", "body", "creator__username")


@admin.register(TranscodingJob)
class TranscodingJobAdmin(admin.ModelAdmin):
    list_display = ("post", "media_type", "status", "progress", "created_at")
    list_filter = ("media_type", "status")
    raw_id_fields = ("post",)


@admin.register(InlineImage)
class InlineImageAdmin(admin.ModelAdmin):
    list_display = ("creator", "image", "created_at")
    raw_id_fields = ("creator",)


@admin.register(Comment)
class CommentAdmin(admin.ModelAdmin):
    list_display = ("user", "project", "post", "created_at")
    list_filter = ("created_at",)
    raw_id_fields = ("user", "project", "post")


@admin.register(Rating)
class RatingAdmin(admin.ModelAdmin):
    list_display = ("user", "project", "score", "created_at")
    list_filter = ("score",)
    raw_id_fields = ("user", "project")
