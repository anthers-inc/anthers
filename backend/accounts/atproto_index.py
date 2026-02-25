"""
ATProto → Django index rebuilder.

Reconstructs Django model data from ATProto records stored in a user's
repository. This is the "ATProto as source of truth" direction — the
inverse of atproto_sync.py (Django → ATProto).

Used for:
- Initial import when a user joins from another Bluebell node
- Reconciliation if Django data and ATProto data diverge
- Disaster recovery (rebuild local index from portable data)
"""

import logging
from datetime import datetime, timezone

import requests

from . import atproto_oauth as oauth

logger = logging.getLogger(__name__)


def _get_session(user):
    try:
        return user.atproto_session
    except Exception:
        return None


def list_records(user, collection, limit=100, cursor=None):
    """List records from a user's ATProto repository.

    Returns (records, cursor) tuple. Cursor is None when no more pages.
    """
    session = _get_session(user)
    if not session:
        return [], None

    pds_url = user.atproto_pds_url
    if not pds_url:
        return [], None

    params = {
        "repo": user.atproto_did,
        "collection": collection,
        "limit": limit,
    }
    if cursor:
        params["cursor"] = cursor

    # Use public API (listRecords is unauthenticated for public repos)
    try:
        resp = requests.get(
            f"{pds_url}/xrpc/com.atproto.repo.listRecords",
            params=params,
            timeout=15,
        )
        if resp.status_code != 200:
            logger.warning("listRecords failed: %s %s", resp.status_code, resp.text[:200])
            return [], None

        data = resp.json()
        return data.get("records", []), data.get("cursor")
    except Exception:
        logger.exception("listRecords error for %s", user.atproto_did)
        return [], None


def get_record(user, collection, rkey):
    """Get a single record from a user's ATProto repository."""
    pds_url = user.atproto_pds_url
    if not pds_url or not user.atproto_did:
        return None

    try:
        resp = requests.get(
            f"{pds_url}/xrpc/com.atproto.repo.getRecord",
            params={
                "repo": user.atproto_did,
                "collection": collection,
                "rkey": rkey,
            },
            timeout=15,
        )
        if resp.status_code == 200:
            return resp.json()
        return None
    except Exception:
        logger.exception("getRecord error")
        return None


# ─── Index Rebuilders ───


def index_games_for_user(user):
    """Rebuild Project records from user's ATProto com.bluebell.game records."""
    from content.models import Project

    cursor = None
    total = 0

    while True:
        records, cursor = list_records(user, "com.bluebell.game", cursor=cursor)
        if not records:
            break

        for record in records:
            uri = record.get("uri", "")
            value = record.get("value", {})

            defaults = {
                "title": value.get("title", "Untitled"),
                "description": value.get("description", ""),
                "short_description": value.get("shortDescription", ""),
                "media_type": value.get("mediaType", "game"),
                "tags": value.get("tags", []),
                "pricing_type": value.get("pricingType", "free"),
                "is_published": value.get("isPublished", False),
                "embed_url": value.get("embedUrl", ""),
                "website_url": value.get("websiteUrl", ""),
                "source_url": value.get("sourceUrl", ""),
            }

            if value.get("price"):
                from decimal import Decimal
                defaults["price"] = Decimal(value["price"])
            if value.get("minPrice"):
                from decimal import Decimal
                defaults["min_price"] = Decimal(value["minPrice"])
            if value.get("suggestedPrice"):
                from decimal import Decimal
                defaults["suggested_price"] = Decimal(value["suggestedPrice"])

            slug = value.get("slug", "")
            if not slug:
                import re
                slug = re.sub(r"[^a-z0-9-]", "-", value.get("title", "").lower()).strip("-")[:255]
                if not slug:
                    slug = f"project-{uri.split('/')[-1]}"

            # Ensure slug uniqueness
            from django.db.models import Q
            if Project.objects.filter(slug=slug).exclude(atproto_uri=uri).exists():
                slug = f"{slug}-{uri.split('/')[-1][:8]}"

            defaults["slug"] = slug

            project, created = Project.objects.update_or_create(
                atproto_uri=uri,
                defaults={"creator": user, **defaults},
            )
            total += 1
            action = "created" if created else "updated"
            logger.info("Indexed game %s: %s (%s)", project.slug, project.title, action)

        if not cursor:
            break

    return total


def index_posts_for_user(user):
    """Rebuild Post records from user's ATProto com.bluebell.post records."""
    from content.models import Post, Project

    cursor = None
    total = 0

    while True:
        records, cursor = list_records(user, "com.bluebell.post", cursor=cursor)
        if not records:
            break

        for record in records:
            uri = record.get("uri", "")
            value = record.get("value", {})

            defaults = {
                "content_type": value.get("contentType", "text"),
                "visibility": value.get("visibility", "public"),
                "is_premium": value.get("isPremium", False),
                "is_published": value.get("isPublished", False),
            }

            if value.get("title"):
                defaults["title"] = value["title"]
            if value.get("body"):
                defaults["body"] = value["body"]
            if value.get("bodyHtml"):
                defaults["body_html"] = value["bodyHtml"]
            if value.get("durationSeconds") is not None:
                defaults["duration_seconds"] = value["durationSeconds"]
            if value.get("estimatedReadMinutes") is not None:
                defaults["estimated_read_minutes"] = value["estimatedReadMinutes"]

            # Link to game project if referenced
            game_uri = value.get("game")
            if game_uri:
                try:
                    project = Project.objects.get(atproto_uri=game_uri)
                    defaults["project"] = project
                except Project.DoesNotExist:
                    pass

            post, created = Post.objects.update_or_create(
                atproto_uri=uri,
                defaults={"creator": user, **defaults},
            )
            total += 1

        if not cursor:
            break

    return total


def index_follows_for_user(user):
    """Rebuild Follow records from user's ATProto com.bluebell.follow records."""
    from accounts.models import Follow, User

    cursor = None
    total = 0

    while True:
        records, cursor = list_records(user, "com.bluebell.follow", cursor=cursor)
        if not records:
            break

        for record in records:
            uri = record.get("uri", "")
            value = record.get("value", {})

            subject_did = value.get("subject", "")
            if not subject_did:
                continue

            try:
                creator = User.objects.get(atproto_did=subject_did)
            except User.DoesNotExist:
                continue

            follow, created = Follow.objects.update_or_create(
                atproto_uri=uri,
                defaults={"follower": user, "creator": creator},
            )
            total += 1

        if not cursor:
            break

    return total


def index_all_for_user(user):
    """Full index rebuild for a user. Returns dict of counts."""
    if not user.atproto_did or not user.atproto_pds_url:
        return {"error": "User has no ATProto identity linked."}

    results = {
        "games": index_games_for_user(user),
        "posts": index_posts_for_user(user),
        "follows": index_follows_for_user(user),
    }

    logger.info(
        "Index rebuild for %s: %d games, %d posts, %d follows",
        user.atproto_did, results["games"], results["posts"], results["follows"],
    )
    return results
