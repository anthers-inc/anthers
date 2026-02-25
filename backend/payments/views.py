import logging
from decimal import Decimal

import stripe
from django.conf import settings
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from content.models import Project

from .fees import calculate_fees
from .models import CRFLedger, CRFSubsidy, Purchase, StripeAccount
from .serializers import (
    CheckoutResponseSerializer,
    CRFSubsidySerializer,
    PurchaseSerializer,
    StripeAccountSerializer,
)

logger = logging.getLogger(__name__)

stripe.api_key = settings.STRIPE_SECRET_KEY


# ─── Stripe Connect Onboarding ───


class StripeOnboardView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        """Return current Stripe account status."""
        try:
            account = request.user.stripe_account
        except StripeAccount.DoesNotExist:
            return Response(
                {"detail": "No Stripe account connected."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(StripeAccountSerializer(account).data)

    def post(self, request):
        """Create or resume Stripe Connect Express onboarding."""
        account, created = StripeAccount.objects.get_or_create(
            user=request.user,
            defaults={"stripe_account_id": ""},
        )

        if created or not account.stripe_account_id:
            stripe_account = stripe.Account.create(
                type="express",
                email=request.user.email,
                metadata={"bluebell_user_id": str(request.user.pk)},
            )
            account.stripe_account_id = stripe_account.id
            account.save(update_fields=["stripe_account_id"])

        # Build the return URL based on the request origin
        origin = request.headers.get("Origin", "http://localhost:3000")
        account_link = stripe.AccountLink.create(
            account=account.stripe_account_id,
            refresh_url=f"{origin}/settings?stripe=refresh",
            return_url=f"{origin}/settings?stripe=complete",
            type="account_onboarding",
        )
        return Response({"url": account_link.url})


# ─── Checkout ───


class CheckoutView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, slug):
        """Create a PaymentIntent for a paid project."""
        try:
            project = Project.objects.select_related(
                "creator__stripe_account"
            ).get(slug=slug, is_published=True)
        except Project.DoesNotExist:
            return Response(
                {"detail": "Project not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if project.pricing_type != "paid":
            return Response(
                {"detail": "This project is free."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not hasattr(project.creator, "stripe_account") or not project.creator.stripe_account.charges_enabled:
            return Response(
                {"detail": "Creator has not set up payments yet."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if project.creator == request.user:
            return Response(
                {"detail": "You cannot purchase your own project."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Check if already purchased
        if Purchase.objects.filter(
            buyer=request.user, project=project, status=Purchase.Status.COMPLETED
        ).exists():
            return Response(
                {"detail": "You already own this project."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        amount = project.price
        fees = calculate_fees(amount)

        intent = stripe.PaymentIntent.create(
            amount=int(amount * 100),  # cents
            currency="usd",
            transfer_data={
                "destination": project.creator.stripe_account.stripe_account_id,
            },
            application_fee_amount=fees["application_fee_cents"],
            metadata={
                "bluebell_project_id": str(project.pk),
                "bluebell_buyer_id": str(request.user.pk),
            },
        )

        Purchase.objects.create(
            buyer=request.user,
            project=project,
            amount=amount,
            processing_fee=fees["processing_fee"],
            crf_fee=fees["crf_fee"],
            creator_earnings=fees["creator_earnings"],
            stripe_payment_intent_id=intent.id,
            status=Purchase.Status.PENDING,
        )

        data = {
            "client_secret": intent.client_secret,
            "amount": amount,
            "processing_fee": fees["processing_fee"],
            "crf_fee": fees["crf_fee"],
            "creator_earnings": fees["creator_earnings"],
        }
        return Response(CheckoutResponseSerializer(data).data)


# ─── Ownership Check ───


class OwnershipCheckView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, slug):
        """Check if the current user owns the given project."""
        try:
            project = Project.objects.get(slug=slug)
        except Project.DoesNotExist:
            return Response(
                {"detail": "Project not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Free projects are always "owned"
        if project.pricing_type == "free":
            return Response({"owns": True})

        # Creator always owns their own project
        if project.creator == request.user:
            return Response({"owns": True})

        # Check for completed purchase
        owns = Purchase.objects.filter(
            buyer=request.user,
            project=project,
            status=Purchase.Status.COMPLETED,
        ).exists()

        return Response({"owns": owns})


# ─── Purchase List ───


class PurchaseListView(generics.ListAPIView):
    serializer_class = PurchaseSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return (
            Purchase.objects.filter(
                buyer=self.request.user,
                status=Purchase.Status.COMPLETED,
            )
            .select_related("project")
            .order_by("-created_at")
        )


# ─── Stripe Webhook ───


class StripeWebhookView(APIView):
    permission_classes = []
    authentication_classes = []

    def post(self, request):
        payload = request.body
        sig_header = request.META.get("HTTP_STRIPE_SIGNATURE", "")

        try:
            event = stripe.Webhook.construct_event(
                payload, sig_header, settings.STRIPE_WEBHOOK_SECRET
            )
        except ValueError:
            return Response(
                {"detail": "Invalid payload."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except stripe.SignatureVerificationError:
            return Response(
                {"detail": "Invalid signature."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if event["type"] == "payment_intent.succeeded":
            self._handle_payment_succeeded(event["data"]["object"])
        elif event["type"] == "account.updated":
            self._handle_account_updated(event["data"]["object"])

        return Response({"status": "ok"})

    def _handle_payment_succeeded(self, payment_intent):
        intent_id = payment_intent["id"]
        try:
            purchase = Purchase.objects.get(stripe_payment_intent_id=intent_id)
        except Purchase.DoesNotExist:
            logger.warning("Webhook: no Purchase for intent %s", intent_id)
            return

        # Idempotent — skip if already completed
        if purchase.status == Purchase.Status.COMPLETED:
            return

        purchase.status = Purchase.Status.COMPLETED
        purchase.save(update_fields=["status", "updated_at"])

        CRFLedger.objects.create(
            amount=purchase.crf_fee,
            purchase=purchase,
            description=f"CRF from purchase of {purchase.project} by {purchase.buyer}",
        )

    def _handle_account_updated(self, account_data):
        account_id = account_data["id"]
        try:
            account = StripeAccount.objects.get(stripe_account_id=account_id)
        except StripeAccount.DoesNotExist:
            return

        account.charges_enabled = account_data.get("charges_enabled", False)
        account.payouts_enabled = account_data.get("payouts_enabled", False)
        account.onboarding_complete = account_data.get("details_submitted", False)
        account.save(update_fields=[
            "charges_enabled", "payouts_enabled", "onboarding_complete", "updated_at"
        ])


# ─── CRF Subsidy ───


class CRFStatusView(APIView):
    """CRF fund status: balance and recent subsidy info for a creator."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        from django.db.models import Sum

        # CRF fund balance
        crf_balance = CRFLedger.objects.aggregate(
            total=Sum("amount")
        )["total"] or Decimal("0.00")

        # Creator's subsidy history
        subsidies = CRFSubsidy.objects.filter(
            creator=request.user
        ).order_by("-billing_cycle")[:6]

        return Response({
            "crf_balance": str(crf_balance),
            "subsidies": CRFSubsidySerializer(subsidies, many=True).data,
        })
