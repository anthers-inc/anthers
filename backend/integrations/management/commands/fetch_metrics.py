"""
Management command to manually fetch external platform metrics.

Usage:
  python manage.py fetch_metrics
  python manage.py fetch_metrics --platform youtube
  python manage.py fetch_metrics --user <username>
"""

from django.core.management.base import BaseCommand

from integrations.models import CrossPublishResult, PlatformConnection
from integrations.tasks import _fetch_metrics_for_platform


class Command(BaseCommand):
    help = "Fetch external platform metrics for cross-published content."

    def add_arguments(self, parser):
        parser.add_argument(
            "--platform",
            type=str,
            choices=["youtube", "steam", "itchio", "substack"],
            help="Only fetch metrics for this platform.",
        )
        parser.add_argument(
            "--user",
            type=str,
            help="Only fetch metrics for this user.",
        )

    def handle(self, *args, **options):
        from django.utils import timezone

        from integrations.models import ExternalMetricSnapshot

        qs = CrossPublishResult.objects.filter(
            status=CrossPublishResult.Status.PUBLISHED,
        ).select_related("user")

        if options["platform"]:
            qs = qs.filter(platform=options["platform"])
        if options["user"]:
            qs = qs.filter(user__username=options["user"])

        today = timezone.now().date()
        total = 0
        errors = 0

        for cross_pub in qs:
            try:
                connection = PlatformConnection.objects.get(
                    user=cross_pub.user,
                    platform=cross_pub.platform,
                    is_active=True,
                )
            except PlatformConnection.DoesNotExist:
                self.stderr.write(
                    f"  No active connection for {cross_pub.user.username}/{cross_pub.platform}"
                )
                continue

            self.stdout.write(
                f"Fetching metrics: {cross_pub.user.username} / "
                f"{cross_pub.platform} / {cross_pub.external_id or 'N/A'}..."
            )

            metrics = _fetch_metrics_for_platform(cross_pub, connection)
            if metrics:
                ExternalMetricSnapshot.objects.update_or_create(
                    cross_publish=cross_pub,
                    snapshot_date=today,
                    defaults=metrics,
                )
                self.stdout.write(
                    self.style.SUCCESS(f"  OK: {metrics}")
                )
                total += 1
            else:
                self.stdout.write(
                    self.style.WARNING("  No metrics returned")
                )
                errors += 1

        self.stdout.write(
            self.style.SUCCESS(f"\nDone: {total} snapshots updated, {errors} skipped.")
        )
