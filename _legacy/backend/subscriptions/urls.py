from django.urls import path

from . import views

urlpatterns = [
    # Public
    path("tiers/", views.TierListView.as_view(), name="subscription-tiers"),

    # Subscription management (authenticated)
    path("me/", views.SubscriptionDetailView.as_view(), name="subscription-detail"),
    path("subscribe/", views.SubscribeView.as_view(), name="subscribe"),
    path("cancel/", views.CancelSubscriptionView.as_view(), name="subscription-cancel"),
    path("resume/", views.ResumeSubscriptionView.as_view(), name="subscription-resume"),
    path("billing-portal/", views.BillingPortalView.as_view(), name="billing-portal"),

    # Attention tracking
    path("attention/", views.AttentionBatchView.as_view(), name="attention-batch"),
    path("attention/summary/", views.AttentionSummaryView.as_view(), name="attention-summary"),

    # Pool distributions
    path("distributions/", views.MyDistributionsView.as_view(), name="my-distributions"),
    path("earnings/", views.CreatorEarningsView.as_view(), name="creator-earnings"),

    # Boost allocations
    path("boosts/", views.BoostListUpdateView.as_view(), name="boost-list-update"),

    # Creator gates
    path("gates/", views.CreatorGateListCreateView.as_view(), name="gate-list-create"),
    path("gates/<int:pk>/", views.CreatorGateDetailView.as_view(), name="gate-detail"),

    # Content access check
    path("access/<int:pk>/", views.ContentAccessCheckView.as_view(), name="content-access-check"),

    # Webhook
    path("webhook/", views.SubscriptionWebhookView.as_view(), name="subscription-webhook"),
]
