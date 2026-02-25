from rest_framework import serializers

from .models import CRFSubsidy, Purchase, StripeAccount


class StripeAccountSerializer(serializers.ModelSerializer):
    class Meta:
        model = StripeAccount
        fields = (
            "stripe_account_id",
            "charges_enabled",
            "payouts_enabled",
            "onboarding_complete",
            "created_at",
        )
        read_only_fields = fields


class CheckoutResponseSerializer(serializers.Serializer):
    client_secret = serializers.CharField()
    amount = serializers.DecimalField(max_digits=8, decimal_places=2)
    processing_fee = serializers.DecimalField(max_digits=8, decimal_places=2)
    crf_fee = serializers.DecimalField(max_digits=8, decimal_places=2)
    creator_earnings = serializers.DecimalField(max_digits=8, decimal_places=2)


class CRFSubsidySerializer(serializers.ModelSerializer):
    class Meta:
        model = CRFSubsidy
        fields = (
            "id",
            "billing_cycle",
            "estimated_hosting_cost",
            "creator_earnings",
            "subsidy_amount",
            "storage_bytes",
            "project_count",
            "post_count",
            "created_at",
        )
        read_only_fields = fields


class PurchaseSerializer(serializers.ModelSerializer):
    project_title = serializers.CharField(source="project.title", read_only=True)
    project_slug = serializers.CharField(source="project.slug", read_only=True)
    project_cover = serializers.ImageField(source="project.cover_image", read_only=True)

    class Meta:
        model = Purchase
        fields = (
            "id",
            "project",
            "project_title",
            "project_slug",
            "project_cover",
            "amount",
            "processing_fee",
            "crf_fee",
            "creator_earnings",
            "status",
            "created_at",
        )
        read_only_fields = fields
