"""Rename subscription tier slugs: window->free, base->root, supporter->sprout,
advocate->petal, champion->bloom."""

from django.db import migrations, models


def rename_tiers_forward(apps, schema_editor):
    """Rename old tier slugs to new ones in all relevant tables."""
    mapping = {
        "window": "free",
        "base": "root",
        "supporter": "sprout",
        "advocate": "petal",
        "champion": "bloom",
    }
    Subscription = apps.get_model("subscriptions", "Subscription")
    for old, new in mapping.items():
        Subscription.objects.filter(tier=old).update(tier=new)

    AttentionEvent = apps.get_model("subscriptions", "AttentionEvent")
    # AttentionEvent doesn't have a tier field — skip

    PoolDistribution = apps.get_model("subscriptions", "PoolDistribution")
    # PoolDistribution doesn't have a tier field — skip


def rename_tiers_backward(apps, schema_editor):
    """Revert new tier slugs back to old ones."""
    mapping = {
        "free": "window",
        "root": "base",
        "sprout": "supporter",
        "petal": "advocate",
        "bloom": "champion",
    }
    Subscription = apps.get_model("subscriptions", "Subscription")
    for old, new in mapping.items():
        Subscription.objects.filter(tier=old).update(tier=new)


class Migration(migrations.Migration):

    dependencies = [
        ("subscriptions", "0002_add_boost_atproto_uri"),
    ]

    operations = [
        # First, rename the data
        migrations.RunPython(rename_tiers_forward, rename_tiers_backward),
        # Then update the field choices to match the new model
        migrations.AlterField(
            model_name="subscription",
            name="tier",
            field=models.CharField(
                choices=[
                    ("free", "Free"),
                    ("root", "Root"),
                    ("sprout", "Sprout"),
                    ("petal", "Petal"),
                    ("bloom", "Bloom"),
                ],
                default="free",
                max_length=20,
            ),
        ),
    ]
