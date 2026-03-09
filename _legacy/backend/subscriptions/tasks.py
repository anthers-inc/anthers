import logging
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from celery import shared_task
from django.db.models import Sum
from django.utils import timezone

from .models import AttentionEvent, BoostAllocation, PoolDistribution, Subscription

logger = logging.getLogger(__name__)


def _get_billing_cycle(sub):
    """Return (cycle_start, cycle_end) for a subscription's current period.

    Falls back to the current calendar month if no Stripe period is set.
    """
    if sub.current_period_start and sub.current_period_end:
        return sub.current_period_start, sub.current_period_end

    now = timezone.now()
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if now.month == 12:
        end = start.replace(year=now.year + 1, month=1)
    else:
        end = start.replace(month=now.month + 1)
    return start, end


def _billing_cycle_date(cycle_start):
    """Return a date object for the first day of the billing cycle (for ledger keys)."""
    if hasattr(cycle_start, "date"):
        return cycle_start.date().replace(day=1)
    return cycle_start.replace(day=1)


@shared_task(name="subscriptions.distribute_pool")
def distribute_pool(subscription_id=None):
    """Distribute creator pool for a single subscriber or all active paid subscribers.

    For each paid subscriber:
    1. Sum attention seconds per creator during the billing cycle.
    2. Distribute the subscriber's creator_pool_amount proportionally.
    3. Apply any boost allocations.
    4. Create/update PoolDistribution ledger entries.
    """
    if subscription_id:
        subs = Subscription.objects.filter(pk=subscription_id, is_active=True).exclude(
            tier=Subscription.Tier.WINDOW
        )
    else:
        subs = Subscription.objects.filter(is_active=True).exclude(
            tier=Subscription.Tier.WINDOW
        )

    processed = 0

    for sub in subs.select_related("user"):
        try:
            _distribute_for_subscriber(sub)
            processed += 1
        except Exception:
            logger.exception("Pool distribution failed for user %s", sub.user_id)

    logger.info("Pool distribution complete: %d subscribers processed", processed)
    return processed


def _distribute_for_subscriber(sub):
    """Run pool distribution for a single subscriber."""
    cycle_start, cycle_end = _get_billing_cycle(sub)
    cycle_date = _billing_cycle_date(cycle_start)

    # 1. Aggregate attention time per creator
    attention_qs = (
        AttentionEvent.objects.filter(
            user=sub.user,
            created_at__gte=cycle_start,
            created_at__lt=cycle_end,
        )
        .values("creator_id")
        .annotate(total_seconds=Sum("duration_seconds"))
        .order_by("-total_seconds")
    )

    attention_by_creator = {
        row["creator_id"]: row["total_seconds"]
        for row in attention_qs
        if row["total_seconds"] > 0
    }

    total_attention = sum(attention_by_creator.values())

    # 2. Calculate proportional pool distribution
    pool_amount = sub.creator_pool_amount  # Decimal

    distributions = {}

    if total_attention > 0 and pool_amount > 0:
        for creator_id, seconds in attention_by_creator.items():
            proportion = Decimal(str(seconds)) / Decimal(str(total_attention))
            amount = (pool_amount * proportion).quantize(
                Decimal("0.01"), rounding=ROUND_HALF_UP
            )
            if amount > 0:
                distributions[creator_id] = {
                    "pool_amount": amount,
                    "attention_seconds": seconds,
                }

        # Correct rounding drift: adjust the largest allocation
        total_distributed = sum(d["pool_amount"] for d in distributions.values())
        drift = pool_amount - total_distributed
        if drift != 0 and distributions:
            largest = max(distributions, key=lambda k: distributions[k]["pool_amount"])
            distributions[largest]["pool_amount"] += drift

    # 3. Apply boost allocations
    boost_allocations = BoostAllocation.objects.filter(
        user=sub.user,
        billing_cycle=cycle_date,
    )

    for boost in boost_allocations:
        cid = boost.creator_id
        if cid not in distributions:
            distributions[cid] = {
                "pool_amount": Decimal("0.00"),
                "attention_seconds": 0,
            }
        distributions[cid]["boost_amount"] = boost.amount

    # 4. Write PoolDistribution ledger entries
    for creator_id, data in distributions.items():
        PoolDistribution.objects.update_or_create(
            subscriber=sub.user,
            creator_id=creator_id,
            billing_cycle=cycle_date,
            defaults={
                "pool_amount": data.get("pool_amount", Decimal("0.00")),
                "boost_amount": data.get("boost_amount", Decimal("0.00")),
                "attention_seconds": data.get("attention_seconds", 0),
            },
        )


@shared_task(name="subscriptions.aggregate_attention")
def aggregate_attention():
    """Trigger pool distribution for all active paid subscribers.

    Intended to run on a schedule (e.g., daily or at billing cycle end).
    """
    return distribute_pool()
