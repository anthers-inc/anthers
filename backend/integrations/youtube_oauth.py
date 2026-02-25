"""
YouTube / Google OAuth 2.0 integration.

Implements the authorization code flow to connect a creator's YouTube channel.
Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Django settings.
"""

import logging
import secrets
from urllib.parse import urlencode

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
YOUTUBE_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"

# Scopes needed for cross-publishing and analytics
SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]


def is_configured():
    """Check if Google OAuth credentials are configured."""
    return bool(
        getattr(settings, "GOOGLE_CLIENT_ID", "")
        and getattr(settings, "GOOGLE_CLIENT_SECRET", "")
    )


def get_redirect_uri(request):
    """Build the OAuth callback URI."""
    configured = getattr(settings, "GOOGLE_REDIRECT_URI", "")
    if configured:
        return configured
    scheme = "https" if request.is_secure() else "http"
    host = request.get_host()
    return f"{scheme}://{host}/api/v1/integrations/platforms/youtube/callback/"


def build_authorization_url(request):
    """Build Google OAuth authorization URL and return (url, state)."""
    state = secrets.token_urlsafe(32)
    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": get_redirect_uri(request),
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    url = f"{GOOGLE_AUTH_URL}?{urlencode(params)}"
    return url, state


def exchange_code(request, code):
    """Exchange authorization code for tokens. Returns token dict or None."""
    try:
        resp = requests.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": get_redirect_uri(request),
            },
            timeout=15,
        )
        if resp.status_code != 200:
            logger.warning(
                "YouTube token exchange failed: %s %s",
                resp.status_code,
                resp.text[:300],
            )
            return None
        return resp.json()
    except Exception:
        logger.exception("YouTube token exchange error")
        return None


def get_channel_info(access_token):
    """Fetch the authenticated user's YouTube channel info."""
    try:
        resp = requests.get(
            YOUTUBE_CHANNELS_URL,
            params={"part": "snippet", "mine": "true"},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=15,
        )
        if resp.status_code != 200:
            logger.warning("YouTube channels API failed: %s", resp.status_code)
            return None

        data = resp.json()
        items = data.get("items", [])
        if not items:
            return None

        channel = items[0]
        return {
            "channel_id": channel["id"],
            "title": channel["snippet"]["title"],
        }
    except Exception:
        logger.exception("YouTube channel info error")
        return None


def refresh_access_token(refresh_token):
    """Refresh an expired access token. Returns new token dict or None."""
    try:
        resp = requests.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=15,
        )
        if resp.status_code != 200:
            logger.warning("YouTube token refresh failed: %s", resp.status_code)
            return None
        return resp.json()
    except Exception:
        logger.exception("YouTube token refresh error")
        return None
