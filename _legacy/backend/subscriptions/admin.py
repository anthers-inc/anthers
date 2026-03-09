from django.contrib import admin

from .models import (
    AttentionEvent,
    BoostAllocation,
    CreatorGate,
    PoolDistribution,
    Subscription,
)


@admin.register(Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    list_display = ["user", "tier", "is_active", "current_period_end", "canceled_at"]
    list_filter = ["tier", "is_active"]
    search_fields = ["user__username", "user__email"]
    raw_id_fields = ["user"]


@admin.register(AttentionEvent)
class AttentionEventAdmin(admin.ModelAdmin):
    list_display = ["user", "creator", "event_type", "duration_seconds", "created_at"]
    list_filter = ["event_type"]
    raw_id_fields = ["user", "creator", "project", "post"]
    date_hierarchy = "created_at"


@admin.register(BoostAllocation)
class BoostAllocationAdmin(admin.ModelAdmin):
    list_display = ["user", "creator", "amount", "billing_cycle", "is_locked"]
    list_filter = ["is_locked"]
    raw_id_fields = ["user", "creator"]


@admin.register(PoolDistribution)
class PoolDistributionAdmin(admin.ModelAdmin):
    list_display = [
        "subscriber", "creator", "pool_amount", "boost_amount",
        "attention_seconds", "billing_cycle",
    ]
    raw_id_fields = ["subscriber", "creator"]


@admin.register(CreatorGate)
class CreatorGateAdmin(admin.ModelAdmin):
    list_display = ["creator", "threshold", "label"]
    raw_id_fields = ["creator"]
