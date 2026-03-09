"""
Django app configuration for Wiki.
"""

from django.apps import AppConfig


class WikiConfig(AppConfig):
    """Configuration for the Wiki app."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "wiki"
    verbose_name = "Wiki Documentation"
