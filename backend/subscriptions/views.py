import logging
from datetime import datetime, timezone

import stripe
from django.conf import settings
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from django.db.models import Sum
from django.utils import timezone as django_timezone

from .models import AttentionEvent, Subscription
from .serializers import SubscriptionSerializer, SubscriptionTierSerializer

logger = logging.getLogger(__name__)

stripe.api_key = settings.STRIPE_SECRET_KEY

# ─── Tier definitions ───

TIER_CONFIG = [
    {
        "tier": "window",
        "name": "Window",
        "price": "0.00",
        "creator_pool": "0.00",
        "boost_pool": "0.00",
        "content_hours": 10,
        "gate_access": False,
    },
    {
        "tier": "base",
        "name": "Base",
        "price": "5.00",
        "creator_pool": "4.85",
        "boost_pool": "0.00",
        "content_hours": 25,
        "gate_access": False,
    },
    {
        "tier": "supporter",
        "name": "Supporter",
        "price": "10.00",
        "creator_pool": "4.70",
        "boost_pool": "5.00",
        "content_hours": None,
        "gate_access": True,
    },
    {
        "tier": "advocate",
        "name": "Advocate",
        "price": "15.00",
        "creator_pool": "4.55",
        "boost_pool": "10.00",
        "content_hours": None,
        "gate_access": True,
    },
    {
        "tier": "champion",
        "name": "Champion",
        "price": "20.00",
        "creator_pool": "4.40",
        "boost_pool": "15.00",
        "content_hours": None,
        "gate_access": True,
    },
]

# Map tier to Stripe Price ID (set via env vars)
TIER_STRIPE_PRICES = {
    "base": settings.STRIPE_PRICE_BASE,
    "supporter": settings.STRIPE_PRICE_SUPPORTER,
    "advocate": settings.STRIPE_PRICE_ADVOCATE,
    "champion": settings.STRIPE_PRICE_CHAMPION,
}


def _get_or_create_stripe_customer(user):
    """Get existing or create new Stripe customer for a user."""
    try:
        sub = user.subscription
        if sub.stripe_customer_id:
            return sub.stripe_customer_id
    except Subscription.DoesNotExist:
        pass

    customer = stripe.Customer.create(
        email=user.email,
        metadata={"bluebell_user_id": str(user.pk)},
    )
    return customer.id


# ─── Tier List ───


class TierListView(APIView):
    permission_classes = []

    def get(self, request):
        """List all available subscription tiers."""
        serializer = SubscriptionTierSerializer(TIER_CONFIG, many=True)
        return Response(serializer.data)


# ─── Current Subscription ───


class SubscriptionDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        """Get the current user's subscription status."""
        try:
            sub = request.user.subscription
        except Subscription.DoesNotExist:
            # No subscription record means Window tier (implicit)
            return Response({
                "tier": "window",
                "tier_display": "Window",
                "is_active": True,
                "is_paid": False,
                "has_boost_pool": False,
                "has_gate_access": False,
                "monthly_content_hours": 10,
                "creator_pool_amount": "0.00",
                "boost_pool_amount": "0.00",
                "current_period_start": None,
                "current_period_end": None,
                "canceled_at": None,
                "created_at": None,
                "updated_at": None,
            })

        return Response(SubscriptionSerializer(sub).data)


# ─── Subscribe / Change Tier ───


class SubscribeView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        """Create or change a subscription. Returns a Stripe Checkout URL."""
        tier = request.data.get("tier")
        if tier not in TIER_STRIPE_PRICES:
            return Response(
                {"detail": f"Invalid tier. Choose from: {', '.join(TIER_STRIPE_PRICES.keys())}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        price_id = TIER_STRIPE_PRICES[tier]
        if not price_id:
            return Response(
                {"detail": "Stripe pricing not configured for this tier."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # Get or create subscription record
        sub, _ = Subscription.objects.get_or_create(
            user=request.user,
            defaults={"tier": "window"},
        )

        # If already on a paid Stripe subscription, update it instead of new checkout
        if sub.stripe_subscription_id:
            try:
                return self._update_existing(sub, tier, price_id)
            except stripe.StripeError as e:
                logger.error("Stripe subscription update error: %s", e)
                return Response(
                    {"detail": "Failed to update subscription."},
                    status=status.HTTP_502_BAD_GATEWAY,
                )

        # New subscription — create Stripe Checkout Session
        try:
            customer_id = _get_or_create_stripe_customer(request.user)

            # Save customer ID
            sub.stripe_customer_id = customer_id
            sub.save(update_fields=["stripe_customer_id", "updated_at"])

            origin = request.headers.get("Origin", "http://localhost:3000")
            session = stripe.checkout.Session.create(
                customer=customer_id,
                mode="subscription",
                line_items=[{"price": price_id, "quantity": 1}],
                success_url=f"{origin}/subscription?session_id={{CHECKOUT_SESSION_ID}}",
                cancel_url=f"{origin}/subscribe?canceled=true",
                metadata={
                    "bluebell_user_id": str(request.user.pk),
                    "bluebell_tier": tier,
                },
                subscription_data={
                    "metadata": {
                        "bluebell_user_id": str(request.user.pk),
                        "bluebell_tier": tier,
                    },
                },
            )

            return Response({"checkout_url": session.url})

        except stripe.StripeError as e:
            logger.error("Stripe checkout error: %s", e)
            return Response(
                {"detail": "Failed to create checkout session."},
                status=status.HTTP_502_BAD_GATEWAY,
            )

    def _update_existing(self, sub, new_tier, price_id):
        """Update an existing Stripe subscription to a different tier."""
        stripe_sub = stripe.Subscription.retrieve(sub.stripe_subscription_id)

        # Update the subscription item's price
        stripe.Subscription.modify(
            sub.stripe_subscription_id,
            items=[{
                "id": stripe_sub["items"]["data"][0]["id"],
                "price": price_id,
            }],
            metadata={
                "bluebell_tier": new_tier,
            },
            proration_behavior="create_prorations",
        )

        sub.tier = new_tier
        sub.save(update_fields=["tier", "updated_at"])

        return Response(SubscriptionSerializer(sub).data)


# ─── Cancel ───


class CancelSubscriptionView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        """Cancel the current subscription at period end."""
        try:
            sub = request.user.subscription
        except Subscription.DoesNotExist:
            return Response(
                {"detail": "No active subscription."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if not sub.stripe_subscription_id:
            return Response(
                {"detail": "No active paid subscription."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            stripe.Subscription.modify(
                sub.stripe_subscription_id,
                cancel_at_period_end=True,
            )
            sub.canceled_at = datetime.now(timezone.utc)
            sub.save(update_fields=["canceled_at", "updated_at"])

            return Response(SubscriptionSerializer(sub).data)

        except stripe.StripeError as e:
            logger.error("Stripe cancel error: %s", e)
            return Response(
                {"detail": "Failed to cancel subscription."},
                status=status.HTTP_502_BAD_GATEWAY,
            )


# ─── Resume (undo cancel) ───


class ResumeSubscriptionView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        """Resume a subscription that was set to cancel at period end."""
        try:
            sub = request.user.subscription
        except Subscription.DoesNotExist:
            return Response(
                {"detail": "No subscription found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if not sub.stripe_subscription_id or not sub.canceled_at:
            return Response(
                {"detail": "Subscription is not pending cancellation."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            stripe.Subscription.modify(
                sub.stripe_subscription_id,
                cancel_at_period_end=False,
            )
            sub.canceled_at = None
            sub.save(update_fields=["canceled_at", "updated_at"])

            return Response(SubscriptionSerializer(sub).data)

        except stripe.StripeError as e:
            logger.error("Stripe resume error: %s", e)
            return Response(
                {"detail": "Failed to resume subscription."},
                status=status.HTTP_502_BAD_GATEWAY,
            )


# ─── Attention Tracking (4B) ───


class AttentionBatchView(APIView):
    """Ingest a batch of attention events from the frontend."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        events = request.data.get("events", [])
        if not events or not isinstance(events, list):
            return Response(
                {"detail": "Provide a non-empty 'events' list."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Cap batch size to prevent abuse
        events = events[:50]

        created = []
        for event_data in events:
            creator_id = event_data.get("creator")
            event_type = event_data.get("event_type")
            duration = event_data.get("duration_seconds", 0)

            if not creator_id or not event_type:
                continue

            # Don't track self-attention
            if int(creator_id) == request.user.pk:
                continue

            # Validate event_type
            if event_type not in dict(AttentionEvent.EventType.choices):
                continue

            # Cap individual duration at 5 minutes (300s) per event
            duration = min(int(duration), 300)

            created.append(AttentionEvent(
                user=request.user,
                creator_id=int(creator_id),
                project_id=event_data.get("project") or None,
                post_id=event_data.get("post") or None,
                event_type=event_type,
                duration_seconds=duration,
            ))

        if created:
            AttentionEvent.objects.bulk_create(created)

        return Response({"created": len(created)}, status=status.HTTP_201_CREATED)


class AttentionSummaryView(APIView):
    """Return the user's content hours used this billing cycle."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        # Determine billing cycle start
        try:
            sub = request.user.subscription
            cycle_start = sub.current_period_start
        except Subscription.DoesNotExist:
            sub = None
            cycle_start = None

        # Fall back to start of current month
        if not cycle_start:
            now = django_timezone.now()
            cycle_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

        total_seconds = (
            AttentionEvent.objects.filter(
                user=request.user,
                created_at__gte=cycle_start,
            ).aggregate(total=Sum("duration_seconds"))["total"]
            or 0
        )

        total_hours = round(total_seconds / 3600, 2)

        # Determine cap
        cap = None
        tier = "window"
        if sub:
            cap = sub.monthly_content_hours
            tier = sub.tier

        return Response({
            "hours_used": total_hours,
            "hours_cap": cap,
            "seconds_used": total_seconds,
            "tier": tier,
            "cycle_start": cycle_start.isoformat() if cycle_start else None,
        })


# ─── Billing Portal ───


class BillingPortalView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        """Create a Stripe billing portal session for self-service management."""
        try:
            sub = request.user.subscription
        except Subscription.DoesNotExist:
            return Response(
                {"detail": "No subscription found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if not sub.stripe_customer_id:
            return Response(
                {"detail": "No Stripe customer on record."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            origin = request.headers.get("Origin", "http://localhost:3000")
            session = stripe.billing_portal.Session.create(
                customer=sub.stripe_customer_id,
                return_url=f"{origin}/subscription",
            )
            return Response({"portal_url": session.url})

        except stripe.StripeError as e:
            logger.error("Stripe billing portal error: %s", e)
            return Response(
                {"detail": "Failed to create billing portal session."},
                status=status.HTTP_502_BAD_GATEWAY,
            )


# ─── Subscription Webhook ───


class SubscriptionWebhookView(APIView):
    permission_classes = []
    authentication_classes = []

    def post(self, request):
        payload = request.body
        sig_header = request.META.get("HTTP_STRIPE_SIGNATURE", "")

        try:
            event = stripe.Webhook.construct_event(
                payload, sig_header, settings.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET
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

        event_type = event["type"]
        data = event["data"]["object"]

        if event_type == "customer.subscription.created":
            self._handle_subscription_created(data)
        elif event_type == "customer.subscription.updated":
            self._handle_subscription_updated(data)
        elif event_type == "customer.subscription.deleted":
            self._handle_subscription_deleted(data)
        elif event_type == "invoice.payment_succeeded":
            self._handle_invoice_paid(data)
        elif event_type == "invoice.payment_failed":
            self._handle_invoice_failed(data)
        elif event_type == "checkout.session.completed":
            self._handle_checkout_completed(data)

        return Response({"status": "ok"})

    def _handle_checkout_completed(self, session):
        """Link Stripe subscription to our Subscription model after checkout."""
        user_id = session.get("metadata", {}).get("bluebell_user_id")
        tier = session.get("metadata", {}).get("bluebell_tier")
        stripe_sub_id = session.get("subscription")

        if not user_id or not stripe_sub_id:
            return

        try:
            sub = Subscription.objects.get(user_id=int(user_id))
        except Subscription.DoesNotExist:
            sub = Subscription(user_id=int(user_id))

        sub.stripe_subscription_id = stripe_sub_id
        sub.stripe_customer_id = session.get("customer", sub.stripe_customer_id)
        sub.tier = tier or sub.tier
        sub.is_active = True
        sub.canceled_at = None
        sub.save()

    def _handle_subscription_created(self, stripe_sub):
        self._sync_subscription(stripe_sub)

    def _handle_subscription_updated(self, stripe_sub):
        self._sync_subscription(stripe_sub)

    def _handle_subscription_deleted(self, stripe_sub):
        """Subscription canceled/expired — revert to Window tier."""
        sub_id = stripe_sub["id"]
        try:
            sub = Subscription.objects.get(stripe_subscription_id=sub_id)
        except Subscription.DoesNotExist:
            return

        sub.tier = Subscription.Tier.WINDOW
        sub.is_active = True  # Window is always "active"
        sub.stripe_subscription_id = ""
        sub.current_period_end = None
        sub.canceled_at = None
        sub.save()

    def _handle_invoice_paid(self, invoice):
        """Update period dates on successful payment."""
        stripe_sub_id = invoice.get("subscription")
        if not stripe_sub_id:
            return

        try:
            sub = Subscription.objects.get(stripe_subscription_id=stripe_sub_id)
        except Subscription.DoesNotExist:
            return

        period_start = invoice.get("period_start")
        period_end = invoice.get("period_end")

        if period_start:
            sub.current_period_start = datetime.fromtimestamp(
                period_start, tz=timezone.utc
            )
        if period_end:
            sub.current_period_end = datetime.fromtimestamp(
                period_end, tz=timezone.utc
            )
        sub.is_active = True
        sub.save(update_fields=[
            "current_period_start", "current_period_end", "is_active", "updated_at"
        ])

    def _handle_invoice_failed(self, invoice):
        """Mark subscription inactive on payment failure."""
        stripe_sub_id = invoice.get("subscription")
        if not stripe_sub_id:
            return

        try:
            sub = Subscription.objects.get(stripe_subscription_id=stripe_sub_id)
        except Subscription.DoesNotExist:
            return

        sub.is_active = False
        sub.save(update_fields=["is_active", "updated_at"])

    def _sync_subscription(self, stripe_sub):
        """Sync Stripe subscription state to our model."""
        sub_id = stripe_sub["id"]
        tier = stripe_sub.get("metadata", {}).get("bluebell_tier")

        try:
            sub = Subscription.objects.get(stripe_subscription_id=sub_id)
        except Subscription.DoesNotExist:
            # Try matching by customer ID
            customer_id = stripe_sub.get("customer")
            try:
                sub = Subscription.objects.get(stripe_customer_id=customer_id)
                sub.stripe_subscription_id = sub_id
            except Subscription.DoesNotExist:
                logger.warning(
                    "Webhook: no Subscription for stripe_sub %s", sub_id
                )
                return

        stripe_status = stripe_sub.get("status")
        sub.is_active = stripe_status in ("active", "trialing")

        if tier and tier in dict(Subscription.Tier.choices):
            sub.tier = tier

        period_start = stripe_sub.get("current_period_start")
        period_end = stripe_sub.get("current_period_end")
        if period_start:
            sub.current_period_start = datetime.fromtimestamp(
                period_start, tz=timezone.utc
            )
        if period_end:
            sub.current_period_end = datetime.fromtimestamp(
                period_end, tz=timezone.utc
            )

        cancel_at = stripe_sub.get("cancel_at_period_end")
        if cancel_at:
            canceled_ts = stripe_sub.get("canceled_at")
            if canceled_ts:
                sub.canceled_at = datetime.fromtimestamp(
                    canceled_ts, tz=timezone.utc
                )
        else:
            sub.canceled_at = None

        sub.save()
