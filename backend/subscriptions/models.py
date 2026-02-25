from decimal import Decimal

from django.conf import settings
from django.db import models


class Subscription(models.Model):
    """A user's platform subscription tier and Stripe billing state."""

    class Tier(models.TextChoices):
        WINDOW = "window", "Window"
        BASE = "base", "Base"
        SUPPORTER = "supporter", "Supporter"
        ADVOCATE = "advocate", "Advocate"
        CHAMPION = "champion", "Champion"

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="subscription",
    )
    tier = models.CharField(
        max_length=20, choices=Tier.choices, default=Tier.WINDOW
    )
    stripe_customer_id = models.CharField(max_length=255, blank=True)
    stripe_subscription_id = models.CharField(max_length=255, blank=True)
    is_active = models.BooleanField(default=True)
    current_period_start = models.DateTimeField(null=True, blank=True)
    current_period_end = models.DateTimeField(null=True, blank=True)
    canceled_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.user} — {self.get_tier_display()} ({'active' if self.is_active else 'inactive'})"

    @property
    def is_paid(self):
        return self.tier != self.Tier.WINDOW and self.is_active

    @property
    def has_boost_pool(self):
        return self.tier in (
            self.Tier.SUPPORTER,
            self.Tier.ADVOCATE,
            self.Tier.CHAMPION,
        ) and self.is_active

    @property
    def has_gate_access(self):
        return self.has_boost_pool

    @property
    def monthly_content_hours(self):
        """Content consumption cap in hours per month. None = unlimited."""
        caps = {
            self.Tier.WINDOW: 10,
            self.Tier.BASE: 25,
        }
        return caps.get(self.tier)  # Supporter+ returns None (unlimited)

    @property
    def creator_pool_amount(self) -> Decimal:
        """Amount from this subscription that goes into the creator pool."""
        amounts = {
            self.Tier.BASE: Decimal("4.85"),
            self.Tier.SUPPORTER: Decimal("4.70"),
            self.Tier.ADVOCATE: Decimal("4.55"),
            self.Tier.CHAMPION: Decimal("4.40"),
        }
        return amounts.get(self.tier, Decimal("0.00"))

    @property
    def boost_pool_amount(self) -> Decimal:
        """Amount from this subscription available for boost allocation."""
        amounts = {
            self.Tier.SUPPORTER: Decimal("5.00"),
            self.Tier.ADVOCATE: Decimal("10.00"),
            self.Tier.CHAMPION: Decimal("15.00"),
        }
        return amounts.get(self.tier, Decimal("0.00"))


class AttentionEvent(models.Model):
    """Tracks user attention on content for pool distribution."""

    class EventType(models.TextChoices):
        PAGE_VIEW = "page_view", "Page View"
        PLAY = "play", "Play"
        WATCH = "watch", "Watch"
        READ = "read", "Read"
        LISTEN = "listen", "Listen"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="attention_events",
    )
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="received_attention",
    )
    project = models.ForeignKey(
        "content.Project",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="attention_events",
    )
    post = models.ForeignKey(
        "content.Post",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="attention_events",
    )
    event_type = models.CharField(
        max_length=20, choices=EventType.choices
    )
    duration_seconds = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["user", "created_at"],
                name="idx_attention_user_date",
            ),
            models.Index(
                fields=["creator", "created_at"],
                name="idx_attention_creator_date",
            ),
        ]

    def __str__(self):
        return f"{self.user} → {self.creator} ({self.event_type}, {self.duration_seconds}s)"


class BoostAllocation(models.Model):
    """A subscriber's manual boost allocation to a specific creator."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="boost_allocations",
    )
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="received_boosts",
    )
    amount = models.DecimalField(max_digits=8, decimal_places=2)
    billing_cycle = models.DateField(
        help_text="First day of the billing cycle this allocation applies to."
    )
    is_locked = models.BooleanField(
        default=False,
        help_text="Locked after first manual adjustment in a billing cycle.",
    )
    atproto_uri = models.CharField(max_length=512, unique=True, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ("user", "creator", "billing_cycle")
        ordering = ["-billing_cycle", "-amount"]

    def __str__(self):
        return f"{self.user} → {self.creator} ${self.amount} ({self.billing_cycle})"


class PoolDistribution(models.Model):
    """Monthly ledger: how much a subscriber contributed to a creator."""

    subscriber = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="pool_distributions",
    )
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="pool_earnings",
    )
    billing_cycle = models.DateField(
        help_text="First day of the billing cycle."
    )
    pool_amount = models.DecimalField(
        max_digits=8, decimal_places=2, default=Decimal("0.00"),
        help_text="Amount from attention-based creator pool.",
    )
    boost_amount = models.DecimalField(
        max_digits=8, decimal_places=2, default=Decimal("0.00"),
        help_text="Amount from manual boost allocation.",
    )
    attention_seconds = models.PositiveIntegerField(
        default=0,
        help_text="Total attention time (seconds) subscriber spent on this creator.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ("subscriber", "creator", "billing_cycle")
        ordering = ["-billing_cycle", "-pool_amount"]

    def __str__(self):
        total = self.pool_amount + self.boost_amount
        return f"{self.subscriber} → {self.creator} ${total} ({self.billing_cycle})"

    @property
    def total_amount(self):
        return self.pool_amount + self.boost_amount


class CreatorGate(models.Model):
    """A threshold set by a creator for gated content access."""

    class Threshold(models.TextChoices):
        TIER_1 = "1.00", "$1/mo"
        TIER_1_50 = "1.50", "$1.50/mo"
        TIER_3 = "3.00", "$3/mo"
        TIER_5 = "5.00", "$5/mo"
        TIER_10 = "10.00", "$10/mo"

    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="gates",
    )
    threshold = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        help_text="Minimum monthly boost amount to unlock this gate.",
    )
    label = models.CharField(max_length=100)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["threshold"]

    def __str__(self):
        return f"{self.creator} — ${self.threshold} ({self.label})"
