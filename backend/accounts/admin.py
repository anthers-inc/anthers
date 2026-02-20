from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ("username", "display_name", "email", "is_creator", "is_staff")
    list_filter = ("is_creator", "is_staff", "is_superuser", "is_active")
    fieldsets = BaseUserAdmin.fieldsets + (
        ("Profile", {"fields": ("display_name", "bio", "is_creator", "avatar")}),
    )
