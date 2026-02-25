"""
Custom Django authentication backend for ATProto DID-based auth.
"""

import logging
import re
import uuid

from django.contrib.auth import get_user_model

User = get_user_model()
logger = logging.getLogger(__name__)


def _generate_username(handle: str) -> str:
    """Generate a unique Django username from an ATProto handle."""
    base = handle
    for suffix in [".bsky.social", ".bsky.network", ".bsky.app"]:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break

    # Sanitize: only keep alphanumeric, hyphens, underscores
    base = re.sub(r"[^a-zA-Z0-9_-]", "-", base).strip("-")[:30]
    if not base:
        base = "user"

    if not User.objects.filter(username=base).exists():
        return base

    for i in range(1, 1000):
        candidate = f"{base}-{i}"
        if not User.objects.filter(username=candidate).exists():
            return candidate

    return f"user-{uuid.uuid4().hex[:8]}"


class ATProtoBackend:
    """Authenticate users by ATProto DID.

    Creates a local User record on first sign-in.
    """

    def authenticate(
        self,
        request,
        atproto_did=None,
        atproto_handle="",
        atproto_pds_url="",
        display_name="",
        avatar_url="",
        **kwargs,
    ):
        if not atproto_did:
            return None

        try:
            user = User.objects.get(atproto_did=atproto_did)
            # Update handle/PDS if changed
            updated_fields = []
            if atproto_handle and user.atproto_handle != atproto_handle:
                user.atproto_handle = atproto_handle
                updated_fields.append("atproto_handle")
            if atproto_pds_url and user.atproto_pds_url != atproto_pds_url:
                user.atproto_pds_url = atproto_pds_url
                updated_fields.append("atproto_pds_url")
            if display_name and not user.display_name:
                user.display_name = display_name
                updated_fields.append("display_name")
            if updated_fields:
                user.save(update_fields=updated_fields)
            return user
        except User.DoesNotExist:
            pass

        # Create new user
        username = _generate_username(atproto_handle or atproto_did)
        user = User(
            username=username,
            atproto_did=atproto_did,
            atproto_handle=atproto_handle,
            atproto_pds_url=atproto_pds_url,
        )
        if display_name:
            user.display_name = display_name
        # No password — user authenticates via ATProto OAuth
        user.set_unusable_password()
        user.save()

        logger.info("Created new user %s for DID %s", username, atproto_did)
        return user

    def get_user(self, user_id):
        try:
            return User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return None
