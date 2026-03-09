from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone


class GameJam(models.Model):
    """A time-limited game creation event."""

    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="hosted_jams",
    )
    title = models.CharField(max_length=255)
    slug = models.SlugField(max_length=255, unique=True)
    description = models.TextField(blank=True)
    theme = models.CharField(
        max_length=255,
        blank=True,
        help_text="Hidden until jam starts.",
    )
    cover_image = models.ImageField(upload_to="jams/covers/", blank=True)

    # Schedule
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    voting_end_at = models.DateTimeField()

    # Settings
    max_team_size = models.PositiveIntegerField(
        default=0, help_text="0 = unlimited"
    )
    allow_late_submissions = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-start_at"]

    def __str__(self):
        return self.title

    @property
    def status(self):
        """Computed jam status based on current time."""
        now = timezone.now()
        if now < self.start_at:
            return "upcoming"
        elif now < self.end_at:
            return "active"
        elif now < self.voting_end_at:
            return "voting"
        else:
            return "ended"

    @property
    def is_theme_visible(self):
        """Theme is only visible after the jam starts."""
        return timezone.now() >= self.start_at

    @property
    def entry_count(self):
        return self.entries.count()


class JamEntry(models.Model):
    """A project submitted to a game jam."""

    jam = models.ForeignKey(
        GameJam, on_delete=models.CASCADE, related_name="entries"
    )
    project = models.ForeignKey(
        "content.Project",
        on_delete=models.CASCADE,
        related_name="jam_entries",
    )
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="jam_entries",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("jam", "project")
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.project.title} in {self.jam.title}"


class JamVote(models.Model):
    """A vote on a jam entry."""

    entry = models.ForeignKey(
        JamEntry, on_delete=models.CASCADE, related_name="votes"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="jam_votes",
    )
    score = models.IntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(5)]
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("entry", "user")
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.user} voted {self.score} on {self.entry}"
