from django.contrib import admin

from .models import Asset, Post, Project


class AssetInline(admin.TabularInline):
    model = Asset
    extra = 0


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ("title", "creator", "media_type", "is_published", "created_at")
    list_filter = ("media_type", "is_published")
    search_fields = ("title", "slug", "creator__username")
    prepopulated_fields = {"slug": ("title",)}
    inlines = [AssetInline]


@admin.register(Asset)
class AssetAdmin(admin.ModelAdmin):
    list_display = ("filename", "project", "mime_type", "file_size", "is_primary", "created_at")
    list_filter = ("is_primary", "platform")


@admin.register(Post)
class PostAdmin(admin.ModelAdmin):
    list_display = ("title", "creator", "project", "is_published", "created_at")
    list_filter = ("is_published",)
    search_fields = ("title", "body", "creator__username")
