from django.conf import settings
from django.db import models


class Project(models.Model):
    class MediaType(models.TextChoices):
        GAME = "game", "Game"
        VIDEO = "video", "Video"
        AUDIO = "audio", "Audio"
        TEXT = "text", "Text"

    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="projects"
    )
    title = models.CharField(max_length=255)
    slug = models.SlugField(max_length=255, unique=True)
    description = models.TextField(blank=True)
    media_type = models.CharField(max_length=10, choices=MediaType.choices, default=MediaType.GAME)
    tags = models.JSONField(default=list, blank=True)
    is_published = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.title


class Asset(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="assets")
    file = models.FileField(upload_to="assets/")
    filename = models.CharField(max_length=255)
    file_size = models.BigIntegerField(default=0)
    mime_type = models.CharField(max_length=100, blank=True)
    platform = models.CharField(max_length=50, blank=True, help_text="For games: windows, mac, linux")
    version = models.CharField(max_length=50, blank=True)
    is_primary = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.filename


class Post(models.Model):
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="posts"
    )
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="posts", null=True, blank=True
    )
    title = models.CharField(max_length=255, blank=True)
    body = models.TextField()
    is_published = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.title or f"Post #{self.pk}"
