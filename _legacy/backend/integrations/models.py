from django.conf import settings
from django.db import models


class PlatformConnection(models.Model):
    """OAuth tokens or API keys linking a creator to an external platform."""

    class Platform(models.TextChoices):
        YOUTUBE = "youtube", "YouTube"
        STEAM = "steam", "Steam"
        ITCHIO = "itchio", "itch.io"
        SUBSTACK = "substack", "Substack"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="platform_connections",
    )
    platform = models.CharField(max_length=20, choices=Platform.choices)

    # OAuth tokens (YouTube, etc.)
    access_token = models.TextField(blank=True)
    refresh_token = models.TextField(blank=True)
    token_expires_at = models.DateTimeField(null=True, blank=True)

    # API key (Steam publisher key, itch.io API key)
    api_key = models.TextField(blank=True)

    # Platform-specific identifiers
    platform_user_id = models.CharField(max_length=255, blank=True)
    platform_username = models.CharField(max_length=255, blank=True)

    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ("user", "platform")

    def __str__(self):
        return f"{self.user.username} — {self.get_platform_display()}"


class CrossPublishResult(models.Model):
    """Tracks content that has been cross-published to external platforms."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PUBLISHED = "published", "Published"
        FAILED = "failed", "Failed"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="cross_publish_results",
    )
    platform = models.CharField(
        max_length=20, choices=PlatformConnection.Platform.choices
    )

    # Local content reference (at least one should be set)
    project = models.ForeignKey(
        "content.Project",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="cross_publishes",
    )
    post = models.ForeignKey(
        "content.Post",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="cross_publishes",
    )

    # External identifiers
    external_id = models.CharField(max_length=255, blank=True)
    external_url = models.URLField(max_length=500, blank=True)

    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING
    )
    error_message = models.TextField(blank=True)
    published_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=["user", "platform"]),
        ]

    def __str__(self):
        content = self.project or self.post
        return f"{content} → {self.get_platform_display()} ({self.status})"


class ExternalMetricSnapshot(models.Model):
    """Daily snapshots of external platform metrics for cross-published content."""

    cross_publish = models.ForeignKey(
        CrossPublishResult,
        on_delete=models.CASCADE,
        related_name="metric_snapshots",
    )

    views = models.IntegerField(default=0)
    likes = models.IntegerField(default=0)
    comments = models.IntegerField(default=0)
    shares = models.IntegerField(default=0)
    watch_time_seconds = models.IntegerField(default=0)
    revenue_cents = models.IntegerField(default=0)

    snapshot_date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("cross_publish", "snapshot_date")
        ordering = ["-snapshot_date"]

    def __str__(self):
        return f"{self.cross_publish} @ {self.snapshot_date}"
