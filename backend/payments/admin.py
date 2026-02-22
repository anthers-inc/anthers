from django.contrib import admin

from .models import CRFLedger, Purchase, StripeAccount


@admin.register(StripeAccount)
class StripeAccountAdmin(admin.ModelAdmin):
    list_display = ("user", "stripe_account_id", "charges_enabled", "payouts_enabled", "onboarding_complete")
    list_filter = ("charges_enabled", "payouts_enabled", "onboarding_complete")


@admin.register(Purchase)
class PurchaseAdmin(admin.ModelAdmin):
    list_display = ("buyer", "project", "amount", "status", "created_at")
    list_filter = ("status",)
    raw_id_fields = ("buyer", "project")


@admin.register(CRFLedger)
class CRFLedgerAdmin(admin.ModelAdmin):
    list_display = ("amount", "description", "purchase", "created_at")
