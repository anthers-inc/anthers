from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models


class Project(models.Model):
    class MediaType(models.TextChoices):
        GAME = "game", "Game"
        VIDEO = "video", "Video"
        AUDIO = "audio", "Audio"
        TEXT = "text", "Text"

    class PricingType(models.TextChoices):
        FREE = "free", "Free"
        PWYW = "pwyw", "Pay What You Want"
        PAID = "paid", "Paid"

    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="projects"
    )
    title = models.CharField(max_length=255)
    slug = models.SlugField(max_length=255, unique=True)
    description = models.TextField(blank=True)
    short_description = models.CharField(max_length=300, blank=True)
    media_type = models.CharField(
        max_length=10, choices=MediaType.choices, default=MediaType.GAME
    )
    tags = models.JSONField(default=list, blank=True)
    is_published = models.BooleanField(default=False)

    # Pricing
    pricing_type = models.CharField(
        max_length=10, choices=PricingType.choices, default=PricingType.FREE
    )
    price = models.DecimalField(
        max_digits=8, decimal_places=2, null=True, blank=True,
        help_text="Fixed price for paid projects",
    )
    min_price = models.DecimalField(
        max_digits=8, decimal_places=2, null=True, blank=True,
        help_text="Minimum price for PWYW",
    )
    suggested_price = models.DecimalField(
        max_digits=8, decimal_places=2, null=True, blank=True,
        help_text="Suggested price for PWYW",
    )

    # Display
    cover_image = models.ImageField(upload_to="covers/", blank=True)
    embed_url = models.URLField(blank=True, help_text="Web game embed URL (HTML5/WebGL)")

    # Metadata
    website_url = models.URLField(blank=True)
    source_url = models.URLField(blank=True, help_text="e.g. GitHub link")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.title


class Screenshot(models.Model):
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="screenshots"
    )
    image = models.ImageField(upload_to="screenshots/")
    caption = models.CharField(max_length=255, blank=True)
    sort_order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["sort_order", "created_at"]

    def __str__(self):
        return f"{self.project.title} screenshot #{self.sort_order}"


class Asset(models.Model):
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="assets"
    )
    file = models.FileField(upload_to="assets/")
    filename = models.CharField(max_length=255)
    file_size = models.BigIntegerField(default=0)
    mime_type = models.CharField(max_length=100, blank=True)
    platform = models.CharField(
        max_length=50, blank=True, help_text="For games: windows, mac, linux"
    )
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


class Comment(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="comments"
    )
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="comments",
        null=True, blank=True,
    )
    post = models.ForeignKey(
        Post, on_delete=models.CASCADE, related_name="comments",
        null=True, blank=True,
    )
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Comment by {self.user} on {self.project or self.post}"


class Rating(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="ratings"
    )
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="ratings"
    )
    score = models.IntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(5)]
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("user", "project")
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.user} rated {self.project}: {self.score}"
