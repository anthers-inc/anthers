"""
CRF subsidy calculation and distribution.

Runs monthly to estimate hosting costs per creator and subsidize small creators
who don't earn enough to cover their infrastructure costs.
"""

import logging
from decimal import ROUND_HALF_UP, Decimal

from celery import shared_task
from django.conf import settings as django_settings
from django.db.models import Sum
from django.utils import timezone

from content.models import Asset, Post, Project

logger = logging.getLogger(__name__)

# Cost model constants (monthly per-creator)
BASE_COST_PER_CREATOR = Decimal("0.50")     # Base hosting overhead
COST_PER_GB_STORAGE = Decimal("0.05")       # Storage cost per GB
COST_PER_PROJECT = Decimal("0.10")          # Per-project CDN/serving cost
COST_PER_MEDIA_POST = Decimal("0.15")       # Per video/audio post (transcoding + HLS)

# Subsidy eligibility threshold: if creator earnings are below this percentage
# of their estimated hosting cost, they qualify for a subsidy.
SUBSIDY_THRESHOLD = Decimal("1.0")  # 100% — subsidize if earnings < hosting cost

# Maximum subsidy per creator per month (cap)
MAX_MONTHLY_SUBSIDY = Decimal("25.00")


def _get_cycle_date():
    """Return the first day of the current month."""
    return timezone.now().date().replace(day=1)


def _estimate_hosting_cost(creator) -> dict:
    """Estimate monthly hosting costs for a creator.

    Returns dict with: total_cost, storage_bytes, project_count, post_count.
    """
    # Count published projects
    project_count = Project.objects.filter(
        creator=creator, is_published=True
    ).count()

    # Count media posts (video/audio have higher costs)
    media_post_count = Post.objects.filter(
        creator=creator,
        is_published=True,
        content_type__in=["video", "audio"],
    ).count()

    text_post_count = Post.objects.filter(
        creator=creator,
        is_published=True,
        content_type="text",
    ).count()

    # Calculate storage used (from assets)
    storage_bytes = Asset.objects.filter(
        project__creator=creator
    ).aggregate(total=Sum("file_size"))["total"] or 0

    storage_gb = Decimal(str(storage_bytes)) / Decimal("1073741824")  # bytes to GB

    total_cost = (
        BASE_COST_PER_CREATOR
        + (COST_PER_GB_STORAGE * storage_gb).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        + (COST_PER_PROJECT * project_count)
        + (COST_PER_MEDIA_POST * media_post_count)
    )

    return {
        "total_cost": total_cost.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
        "storage_bytes": storage_bytes,
        "project_count": project_count,
        "post_count": text_post_count + media_post_count,
    }


def _get_creator_earnings(creator, cycle_date) -> Decimal:
    """Sum a creator's earnings for the current cycle.

    Includes: pool distributions, boost distributions, and marketplace sales.
    """
    from subscriptions.models import PoolDistribution

    pool_earnings = PoolDistribution.objects.filter(
        creator=creator,
        billing_cycle=cycle_date,
    ).aggregate(
        pool_total=Sum("pool_amount"),
        boost_total=Sum("boost_amount"),
    )

    pool_amount = pool_earnings["pool_total"] or Decimal("0.00")
    boost_amount = pool_earnings["boost_total"] or Decimal("0.00")

    from payments.models import Purchase

    # Marketplace earnings this month
    month_start = timezone.now().replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    if timezone.now().month == 12:
        month_end = month_start.replace(year=month_start.year + 1, month=1)
    else:
        month_end = month_start.replace(month=month_start.month + 1)

    marketplace_earnings = Purchase.objects.filter(
        project__creator=creator,
        status=Purchase.Status.COMPLETED,
        created_at__gte=month_start,
        created_at__lt=month_end,
    ).aggregate(total=Sum("creator_earnings"))["total"] or Decimal("0.00")

    return pool_amount + boost_amount + marketplace_earnings


@shared_task(name="payments.calculate_crf_subsidies")
def calculate_crf_subsidies():
    """Calculate and distribute CRF subsidies to eligible small creators.

    A creator qualifies for a subsidy if their monthly earnings are less than
    their estimated hosting costs. The subsidy covers the gap, up to a cap.
    """
    from django.contrib.auth import get_user_model
    from payments.models import CRFLedger, CRFSubsidy

    User = get_user_model()
    cycle_date = _get_cycle_date()

    # Get CRF balance
    crf_balance = CRFLedger.objects.aggregate(
        total=Sum("amount")
    )["total"] or Decimal("0.00")

    if crf_balance <= 0:
        logger.info("CRF balance is zero or negative. Skipping subsidies.")
        return 0

    # Find all creators with published content
    creators = User.objects.filter(
        is_creator=True,
        projects__is_published=True,
    ).distinct()

    subsidized = 0
    total_subsidy = Decimal("0.00")

    for creator in creators:
        # Skip if already subsidized this cycle
        if CRFSubsidy.objects.filter(
            creator=creator, billing_cycle=cycle_date
        ).exists():
            continue

        cost_info = _estimate_hosting_cost(creator)
        hosting_cost = cost_info["total_cost"]
        earnings = _get_creator_earnings(creator, cycle_date)

        # Check eligibility
        if earnings >= hosting_cost * SUBSIDY_THRESHOLD:
            # Creator earns enough to cover hosting
            CRFSubsidy.objects.update_or_create(
                creator=creator,
                billing_cycle=cycle_date,
                defaults={
                    "estimated_hosting_cost": hosting_cost,
                    "creator_earnings": earnings,
                    "subsidy_amount": Decimal("0.00"),
                    "storage_bytes": cost_info["storage_bytes"],
                    "project_count": cost_info["project_count"],
                    "post_count": cost_info["post_count"],
                },
            )
            continue

        # Calculate subsidy: cover the gap between earnings and hosting cost
        gap = hosting_cost - earnings
        subsidy = min(gap, MAX_MONTHLY_SUBSIDY, crf_balance - total_subsidy)

        if subsidy <= 0:
            logger.info("CRF budget exhausted after %d subsidies.", subsidized)
            break

        subsidy = subsidy.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

        CRFSubsidy.objects.update_or_create(
            creator=creator,
            billing_cycle=cycle_date,
            defaults={
                "estimated_hosting_cost": hosting_cost,
                "creator_earnings": earnings,
                "subsidy_amount": subsidy,
                "storage_bytes": cost_info["storage_bytes"],
                "project_count": cost_info["project_count"],
                "post_count": cost_info["post_count"],
            },
        )

        # Record CRF outflow (negative amount)
        CRFLedger.objects.create(
            amount=-subsidy,
            description=(
                f"CRF subsidy for {creator.username} — "
                f"hosting ${hosting_cost}, earnings ${earnings}, subsidy ${subsidy}"
            ),
        )

        total_subsidy += subsidy
        subsidized += 1

    logger.info(
        "CRF subsidy calculation complete: %d creators subsidized, $%s total",
        subsidized,
        total_subsidy,
    )
    return subsidized
