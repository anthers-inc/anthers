"""
Management command to rebuild the Django index from ATProto records.

Usage:
  python manage.py atproto_reindex --user <username>
  python manage.py atproto_reindex --all
"""

from django.core.management.base import BaseCommand, CommandError

from accounts.models import User


class Command(BaseCommand):
    help = "Rebuild Django index from ATProto repository records."

    def add_arguments(self, parser):
        group = parser.add_mutually_exclusive_group(required=True)
        group.add_argument(
            "--user",
            type=str,
            help="Username to reindex.",
        )
        group.add_argument(
            "--all",
            action="store_true",
            help="Reindex all users with linked ATProto identities.",
        )

    def handle(self, *args, **options):
        from accounts.atproto_index import index_all_for_user

        if options["user"]:
            try:
                user = User.objects.get(username=options["user"])
            except User.DoesNotExist:
                raise CommandError(f"User '{options['user']}' not found.")

            if not user.atproto_did:
                raise CommandError(f"User '{user.username}' has no ATProto identity linked.")

            self.stdout.write(f"Reindexing {user.username} ({user.atproto_did})...")
            results = index_all_for_user(user)
            self._print_results(user.username, results)

        elif options["all"]:
            users = User.objects.filter(
                atproto_did__isnull=False,
                atproto_pds_url__gt="",
            )
            if not users.exists():
                self.stdout.write("No users with ATProto identities found.")
                return

            for user in users:
                self.stdout.write(f"Reindexing {user.username} ({user.atproto_did})...")
                results = index_all_for_user(user)
                self._print_results(user.username, results)

    def _print_results(self, username, results):
        if "error" in results:
            self.stderr.write(self.style.ERROR(f"  Error: {results['error']}"))
        else:
            self.stdout.write(self.style.SUCCESS(
                f"  {username}: {results['games']} games, "
                f"{results['posts']} posts, {results['follows']} follows"
            ))
