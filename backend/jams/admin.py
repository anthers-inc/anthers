from django.contrib import admin

from .models import GameJam, JamEntry, JamVote


@admin.register(GameJam)
class GameJamAdmin(admin.ModelAdmin):
    list_display = [
        "title",
        "slug",
        "creator",
        "status",
        "start_at",
        "end_at",
        "voting_end_at",
        "entry_count",
    ]
    list_filter = ["start_at"]
    search_fields = ["title", "slug"]
    prepopulated_fields = {"slug": ("title",)}
    readonly_fields = ["created_at", "updated_at"]


@admin.register(JamEntry)
class JamEntryAdmin(admin.ModelAdmin):
    list_display = ["project", "jam", "submitted_by", "created_at"]
    list_filter = ["jam"]
    search_fields = ["project__title", "submitted_by__username"]


@admin.register(JamVote)
class JamVoteAdmin(admin.ModelAdmin):
    list_display = ["user", "entry", "score", "created_at"]
    list_filter = ["score"]
