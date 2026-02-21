from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    display_name = models.CharField(max_length=150, blank=True)
    bio = models.TextField(blank=True)
    is_creator = models.BooleanField(default=False)
    avatar = models.ImageField(upload_to="avatars/", blank=True)

    # Creator profile (Patreon-like)
    header_image = models.ImageField(upload_to="headers/", blank=True)
    website_url = models.URLField(blank=True)
    location = models.CharField(max_length=100, blank=True)

    def __str__(self):
        return self.display_name or self.username


class Follow(models.Model):
    follower = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="following"
    )
    creator = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="followers"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("follower", "creator")
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.follower} → {self.creator}"
