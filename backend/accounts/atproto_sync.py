"""
ATProto write-path utilities.

Syncs Django records to ATProto repositories via the user's PDS.
All sync operations are best-effort — local Django records are always
the immediate source for queries; ATProto is the canonical portable store.
"""

import logging
import time
import uuid

import requests

from . import atproto_oauth as oauth

logger = logging.getLogger(__name__)


def _get_session(user):
    """Get the ATProtoSession for a user, or None if not linked."""
    try:
        return user.atproto_session
    except Exception:
        return None


def _refresh_token_if_needed(session):
    """Refresh the access token using the refresh token.

    Returns True if token was refreshed successfully.
    """
    if not session.refresh_token or not session.token_endpoint:
        return False

    try:
        dpop_proof = oauth.create_dpop_proof(
            "POST",
            session.token_endpoint,
            session.dpop_private_pem,
            session.dpop_jwk,
            nonce=session.dpop_nonce or None,
        )

        resp = requests.post(
            session.token_endpoint,
            data={
                "grant_type": "refresh_token",
                "refresh_token": session.refresh_token,
            },
            headers={"DPoP": dpop_proof},
            timeout=15,
        )

        # Handle DPoP nonce requirement
        if resp.status_code == 400:
            error_data = resp.json()
            if error_data.get("error") == "use_dpop_nonce":
                new_nonce = resp.headers.get("DPoP-Nonce")
                if new_nonce:
                    session.dpop_nonce = new_nonce
                    session.save(update_fields=["dpop_nonce"])
                    return _refresh_token_if_needed(session)

        if resp.status_code != 200:
            logger.warning("Token refresh failed: %s", resp.text[:200])
            return False

        data = resp.json()
        session.access_token = data["access_token"]
        if "refresh_token" in data:
            session.refresh_token = data["refresh_token"]
        if "DPoP-Nonce" in resp.headers:
            session.dpop_nonce = resp.headers["DPoP-Nonce"]
        session.save(update_fields=[
            "access_token", "refresh_token", "dpop_nonce", "updated_at",
        ])
        return True

    except Exception:
        logger.exception("Token refresh error")
        return False


def _pds_request(session, method, path, json_data=None):
    """Make an authenticated request to the user's PDS.

    Returns the response dict or None on failure.
    Handles DPoP nonce retry and token refresh.
    """
    pds_url = session.user.atproto_pds_url
    if not pds_url:
        return None

    url = f"{pds_url}{path}"

    dpop_proof = oauth.create_dpop_proof(
        method, url, session.dpop_private_pem, session.dpop_jwk,
        nonce=session.dpop_nonce or None,
        access_token=session.access_token,
    )

    headers = {
        "Authorization": f"DPoP {session.access_token}",
        "DPoP": dpop_proof,
    }
    if json_data:
        headers["Content-Type"] = "application/json"

    resp = requests.request(
        method, url, json=json_data, headers=headers, timeout=15,
    )

    # Handle DPoP nonce requirement
    if resp.status_code == 401:
        new_nonce = resp.headers.get("DPoP-Nonce")
        if new_nonce:
            session.dpop_nonce = new_nonce
            session.save(update_fields=["dpop_nonce"])
            # Retry with nonce
            return _pds_request(session, method, path, json_data)

        # Token might be expired — try refresh
        if _refresh_token_if_needed(session):
            return _pds_request(session, method, path, json_data)

    if resp.status_code not in (200, 201):
        logger.warning(
            "PDS request failed: %s %s → %s %s",
            method, path, resp.status_code, resp.text[:200],
        )
        return None

    # Store nonce for future requests
    if "DPoP-Nonce" in resp.headers:
        session.dpop_nonce = resp.headers["DPoP-Nonce"]
        session.save(update_fields=["dpop_nonce"])

    return resp.json()


def _generate_tid():
    """Generate a TID (timestamp-based ID) for ATProto records."""
    # TID format: microseconds since Unix epoch, base32-sorted
    # Using a simplified version
    ts = int(time.time() * 1_000_000)
    return _base32_sort_encode(ts)


def _base32_sort_encode(n: int) -> str:
    """Encode an integer as a base32-sortable string (ATProto TID format)."""
    chars = "234567abcdefghijklmnopqrstuvwxyz"
    result = []
    for _ in range(13):
        result.append(chars[n & 0x1F])
        n >>= 5
    return "".join(reversed(result))


# ─── Record Write Functions ───


def sync_project_to_atproto(project):
    """Sync a Project record to ATProto. Returns the atproto_uri or None."""
    user = project.creator
    if not user.atproto_did:
        return None

    session = _get_session(user)
    if not session or not session.access_token:
        return None

    record = {
        "title": project.title,
        "slug": project.slug,
        "description": project.description,
        "shortDescription": project.short_description,
        "mediaType": project.media_type,
        "tags": project.tags or [],
        "pricingType": project.pricing_type,
        "isPublished": project.is_published,
        "createdAt": project.created_at.isoformat() if project.created_at else None,
    }

    if project.price is not None:
        record["price"] = str(project.price)
    if project.min_price is not None:
        record["minPrice"] = str(project.min_price)
    if project.suggested_price is not None:
        record["suggestedPrice"] = str(project.suggested_price)
    if project.embed_url:
        record["embedUrl"] = project.embed_url
    if project.website_url:
        record["websiteUrl"] = project.website_url
    if project.source_url:
        record["sourceUrl"] = project.source_url

    return _write_record(session, "com.bluebell.game", record, project)


def sync_post_to_atproto(post):
    """Sync a Post record to ATProto. Returns the atproto_uri or None."""
    user = post.creator
    if not user.atproto_did:
        return None

    session = _get_session(user)
    if not session or not session.access_token:
        return None

    record = {
        "contentType": post.content_type,
        "visibility": post.visibility,
        "isPremium": post.is_premium,
        "isPublished": post.is_published,
        "createdAt": post.created_at.isoformat() if post.created_at else None,
    }

    if post.title:
        record["title"] = post.title
    if post.body:
        record["body"] = post.body
    if post.body_html:
        record["bodyHtml"] = post.body_html
    if post.duration_seconds is not None:
        record["durationSeconds"] = post.duration_seconds
    if post.estimated_read_minutes is not None:
        record["estimatedReadMinutes"] = post.estimated_read_minutes

    # Link to parent game if it has an atproto_uri
    if post.project and post.project.atproto_uri:
        record["game"] = post.project.atproto_uri

    return _write_record(session, "com.bluebell.post", record, post)


def sync_rating_to_atproto(rating):
    """Sync a Rating record to ATProto."""
    user = rating.user
    if not user.atproto_did:
        return None

    session = _get_session(user)
    if not session or not session.access_token:
        return None

    record = {
        "score": rating.score,
        "createdAt": rating.created_at.isoformat() if rating.created_at else None,
    }

    if rating.project.atproto_uri:
        record["subject"] = rating.project.atproto_uri

    return _write_record(session, "com.bluebell.rating", record, rating)


def sync_follow_to_atproto(follow):
    """Sync a Follow record to ATProto."""
    user = follow.follower
    if not user.atproto_did:
        return None

    session = _get_session(user)
    if not session or not session.access_token:
        return None

    # Use the creator's DID as subject
    creator_did = follow.creator.atproto_did
    if not creator_did:
        return None

    record = {
        "subject": creator_did,
        "createdAt": follow.created_at.isoformat() if follow.created_at else None,
    }

    return _write_record(session, "com.bluebell.follow", record, follow)


def sync_boost_to_atproto(boost):
    """Sync a BoostAllocation record to ATProto."""
    user = boost.user
    if not user.atproto_did:
        return None

    session = _get_session(user)
    if not session or not session.access_token:
        return None

    creator_did = boost.creator.atproto_did
    if not creator_did:
        return None

    record = {
        "subject": creator_did,
        "amount": str(boost.amount),
        "billingCycle": boost.billing_cycle.isoformat(),
        "isLocked": boost.is_locked,
        "createdAt": boost.created_at.isoformat() if boost.created_at else None,
    }

    return _write_record(session, "com.bluebell.boost", record, boost)


def delete_record_from_atproto(user, atproto_uri):
    """Delete an ATProto record by URI."""
    if not user.atproto_did or not atproto_uri:
        return False

    session = _get_session(user)
    if not session or not session.access_token:
        return False

    # Parse collection and rkey from URI: at://did/collection/rkey
    parts = atproto_uri.replace("at://", "").split("/")
    if len(parts) < 3:
        return False

    collection = parts[1]
    rkey = parts[2]

    result = _pds_request(
        session, "POST",
        "/xrpc/com.atproto.repo.deleteRecord",
        {
            "repo": user.atproto_did,
            "collection": collection,
            "rkey": rkey,
        },
    )
    return result is not None


# ─── Internal ───


def _write_record(session, collection, record, django_obj):
    """Write or update a record in the user's ATProto repository.

    If the django_obj already has an atproto_uri, updates the existing record.
    Otherwise creates a new one.
    """
    did = session.user.atproto_did
    existing_uri = getattr(django_obj, "atproto_uri", None)

    if existing_uri:
        # Update existing record
        parts = existing_uri.replace("at://", "").split("/")
        rkey = parts[2] if len(parts) >= 3 else None
        if rkey:
            result = _pds_request(
                session, "POST",
                "/xrpc/com.atproto.repo.putRecord",
                {
                    "repo": did,
                    "collection": collection,
                    "rkey": rkey,
                    "record": record,
                },
            )
            if result:
                return existing_uri
    else:
        # Create new record
        rkey = _generate_tid()
        result = _pds_request(
            session, "POST",
            "/xrpc/com.atproto.repo.createRecord",
            {
                "repo": did,
                "collection": collection,
                "rkey": rkey,
                "record": record,
            },
        )
        if result and "uri" in result:
            uri = result["uri"]
            django_obj.atproto_uri = uri
            django_obj.save(update_fields=["atproto_uri"])
            return uri

    return None
