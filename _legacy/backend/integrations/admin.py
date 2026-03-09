from django.contrib import admin

from .models import CrossPublishResult, ExternalMetricSnapshot, PlatformConnection


@admin.register(PlatformConnection)
class PlatformConnectionAdmin(admin.ModelAdmin):
    list_display = ["user", "platform", "platform_username", "is_active", "created_at"]
    list_filter = ["platform", "is_active"]
    search_fields = ["user__username", "platform_username"]
    readonly_fields = ["created_at", "updated_at"]


@admin.register(CrossPublishResult)
class CrossPublishResultAdmin(admin.ModelAdmin):
    list_display = [
        "user",
        "platform",
        "project",
        "post",
        "status",
        "external_url",
        "published_at",
    ]
    list_filter = ["platform", "status"]
    search_fields = ["user__username", "external_id"]
    readonly_fields = ["created_at", "updated_at"]


@admin.register(ExternalMetricSnapshot)
class ExternalMetricSnapshotAdmin(admin.ModelAdmin):
    list_display = [
        "cross_publish",
        "snapshot_date",
        "views",
        "likes",
        "comments",
        "revenue_cents",
    ]
    list_filter = ["snapshot_date"]
    readonly_fields = ["created_at"]
