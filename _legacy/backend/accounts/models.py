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

    # ATProto / Bluesky identity
    atproto_did = models.CharField(
        max_length=255, unique=True, null=True, blank=True,
        help_text="Decentralized Identifier (e.g. did:plc:abc123)",
    )
    atproto_handle = models.CharField(
        max_length=255, blank=True, default="",
        help_text="ATProto handle (e.g. alice.bsky.social)",
    )
    atproto_pds_url = models.URLField(
        blank=True, default="",
        help_text="Personal Data Server URL",
    )

    def __str__(self):
        return self.display_name or self.username


class ATProtoSession(models.Model):
    """Stores ATProto OAuth tokens and DPoP key for PDS write access."""
    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="atproto_session"
    )
    access_token = models.TextField(blank=True)
    refresh_token = models.TextField(blank=True)
    dpop_private_pem = models.TextField(blank=True)
    dpop_jwk = models.JSONField(default=dict, blank=True)
    token_endpoint = models.URLField(blank=True)
    dpop_nonce = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"ATProto session for {self.user}"


class Follow(models.Model):
    follower = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="following"
    )
    creator = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="followers"
    )
    atproto_uri = models.CharField(max_length=512, unique=True, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("follower", "creator")
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.follower} → {self.creator}"
