from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import Follow, User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ("username", "display_name", "email", "is_creator", "atproto_handle", "is_staff")
    list_filter = ("is_creator", "is_staff", "is_superuser", "is_active")
    fieldsets = BaseUserAdmin.fieldsets + (
        (
            "Profile",
            {
                "fields": (
                    "display_name", "bio", "is_creator", "avatar",
                    "header_image", "website_url", "location",
                ),
            },
        ),
        (
            "ATProto / Bluesky",
            {
                "fields": ("atproto_did", "atproto_handle", "atproto_pds_url"),
            },
        ),
    )
    readonly_fields = ("atproto_did", "atproto_handle", "atproto_pds_url")


@admin.register(Follow)
class FollowAdmin(admin.ModelAdmin):
    list_display = ("follower", "creator", "created_at")
    list_filter = ("created_at",)
    raw_id_fields = ("follower", "creator")
