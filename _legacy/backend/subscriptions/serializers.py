from rest_framework import serializers

from .models import (
    AttentionEvent,
    BoostAllocation,
    CreatorGate,
    PoolDistribution,
    Subscription,
)


# ─── Subscription (4A) ───


class SubscriptionSerializer(serializers.ModelSerializer):
    tier_display = serializers.CharField(
        source="get_tier_display", read_only=True
    )
    monthly_content_hours = serializers.IntegerField(read_only=True)
    creator_pool_amount = serializers.DecimalField(
        max_digits=8, decimal_places=2, read_only=True
    )
    boost_pool_amount = serializers.DecimalField(
        max_digits=8, decimal_places=2, read_only=True
    )

    class Meta:
        model = Subscription
        fields = [
            "id",
            "tier",
            "tier_display",
            "is_active",
            "is_paid",
            "has_boost_pool",
            "has_gate_access",
            "monthly_content_hours",
            "creator_pool_amount",
            "boost_pool_amount",
            "current_period_start",
            "current_period_end",
            "canceled_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class SubscriptionTierSerializer(serializers.Serializer):
    """Read-only representation of a tier option for the subscribe page."""

    tier = serializers.CharField()
    name = serializers.CharField()
    price = serializers.DecimalField(max_digits=5, decimal_places=2)
    creator_pool = serializers.DecimalField(max_digits=5, decimal_places=2)
    boost_pool = serializers.DecimalField(max_digits=5, decimal_places=2)
    content_hours = serializers.IntegerField(allow_null=True)
    gate_access = serializers.BooleanField()


# ─── Attention Events (4B) ───


class AttentionEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = AttentionEvent
        fields = [
            "id",
            "creator",
            "project",
            "post",
            "event_type",
            "duration_seconds",
            "created_at",
        ]
        read_only_fields = ["id", "created_at"]


class AttentionEventBatchSerializer(serializers.Serializer):
    """Accepts a batch of attention events."""

    events = AttentionEventSerializer(many=True)


# ─── Boost Allocations (4D) ───


class BoostAllocationSerializer(serializers.ModelSerializer):
    creator_username = serializers.CharField(
        source="creator.username", read_only=True
    )
    creator_display_name = serializers.CharField(
        source="creator.display_name", read_only=True
    )
    creator_avatar = serializers.ImageField(
        source="creator.avatar", read_only=True
    )

    class Meta:
        model = BoostAllocation
        fields = [
            "id",
            "creator",
            "creator_username",
            "creator_display_name",
            "creator_avatar",
            "amount",
            "billing_cycle",
            "is_locked",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "billing_cycle",
            "is_locked",
            "created_at",
            "updated_at",
        ]


# ─── Pool Distributions (4C) ───


class PoolDistributionSerializer(serializers.ModelSerializer):
    creator_username = serializers.CharField(
        source="creator.username", read_only=True
    )
    creator_display_name = serializers.CharField(
        source="creator.display_name", read_only=True
    )
    total_amount = serializers.DecimalField(
        max_digits=8, decimal_places=2, read_only=True
    )

    class Meta:
        model = PoolDistribution
        fields = [
            "id",
            "creator",
            "creator_username",
            "creator_display_name",
            "billing_cycle",
            "pool_amount",
            "boost_amount",
            "total_amount",
            "attention_seconds",
            "created_at",
        ]
        read_only_fields = fields


# ─── Creator Gates (4D) ───


class CreatorGateSerializer(serializers.ModelSerializer):
    class Meta:
        model = CreatorGate
        fields = [
            "id",
            "threshold",
            "label",
            "description",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]
