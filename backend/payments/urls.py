from django.urls import path

from . import views

urlpatterns = [
    path("stripe/onboard/", views.StripeOnboardView.as_view(), name="stripe-onboard"),
    path("checkout/<slug:slug>/", views.CheckoutView.as_view(), name="checkout"),
    path("owns/<slug:slug>/", views.OwnershipCheckView.as_view(), name="ownership-check"),
    path("purchases/", views.PurchaseListView.as_view(), name="purchase-list"),
    path("stripe/webhook/", views.StripeWebhookView.as_view(), name="stripe-webhook"),
    path("crf/status/", views.CRFStatusView.as_view(), name="crf-status"),
]
