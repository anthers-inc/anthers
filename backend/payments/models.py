from django.conf import settings
from django.db import models


class StripeAccount(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="stripe_account",
    )
    stripe_account_id = models.CharField(max_length=255, unique=True)
    charges_enabled = models.BooleanField(default=False)
    payouts_enabled = models.BooleanField(default=False)
    onboarding_complete = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.user} — {self.stripe_account_id}"


class Purchase(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        COMPLETED = "completed", "Completed"
        FAILED = "failed", "Failed"
        REFUNDED = "refunded", "Refunded"

    buyer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="purchases",
    )
    project = models.ForeignKey(
        "content.Project",
        on_delete=models.CASCADE,
        related_name="purchases",
    )
    amount = models.DecimalField(max_digits=8, decimal_places=2)
    processing_fee = models.DecimalField(max_digits=8, decimal_places=2)
    crf_fee = models.DecimalField(max_digits=8, decimal_places=2)
    creator_earnings = models.DecimalField(max_digits=8, decimal_places=2)
    stripe_payment_intent_id = models.CharField(max_length=255, unique=True)
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.buyer} → {self.project} ({self.status})"


class CRFLedger(models.Model):
    amount = models.DecimalField(max_digits=8, decimal_places=2)
    purchase = models.ForeignKey(
        Purchase,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="crf_entries",
    )
    description = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"CRF {self.amount} — {self.description}"
