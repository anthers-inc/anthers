import logging

from django.conf import settings as django_settings
from django.contrib.auth import authenticate, login, logout
from django.db.models import Count, Exists, OuterRef, Value
from django.shortcuts import redirect
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Follow, User
from .serializers import (
    LoginSerializer,
    PublicUserSerializer,
    RegisterSerializer,
    UserSerializer,
)

logger = logging.getLogger(__name__)


# ─── Auth ───


class RegisterView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        login(request, user)
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)


class LoginView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data["user"]
        login(request, user)
        return Response(UserSerializer(user).data)


class LogoutView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ─── Current User ───


class CurrentUserView(generics.RetrieveUpdateAPIView):
    serializer_class = UserSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        return self.request.user


# ─── Public Profiles ───


class CreatorListView(generics.ListAPIView):
    serializer_class = PublicUserSerializer

    def get_queryset(self):
        qs = User.objects.filter(is_creator=True, is_active=True).annotate(
            follower_count=Count("followers"),
            project_count=Count("projects"),
        )
        if self.request.user.is_authenticated:
            qs = qs.annotate(
                is_following=Exists(
                    Follow.objects.filter(
                        follower=self.request.user,
                        creator=OuterRef("pk"),
                    )
                )
            )
        else:
            qs = qs.annotate(is_following=Value(False))
        return qs


class UserProfileView(generics.RetrieveAPIView):
    """Public profile by username."""

    serializer_class = PublicUserSerializer
    lookup_field = "username"

    def get_queryset(self):
        qs = User.objects.filter(is_active=True).annotate(
            follower_count=Count("followers"),
            project_count=Count("projects"),
        )
        if self.request.user.is_authenticated:
            qs = qs.annotate(
                is_following=Exists(
                    Follow.objects.filter(
                        follower=self.request.user,
                        creator=OuterRef("pk"),
                    )
                )
            )
        else:
            qs = qs.annotate(is_following=Value(False))
        return qs


# ─── Follow / Unfollow ───


class FollowView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, username):
        try:
            creator = User.objects.get(username=username, is_active=True)
        except User.DoesNotExist:
            return Response(
                {"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND
            )
        if creator == request.user:
            return Response(
                {"detail": "You cannot follow yourself."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        follow, created = Follow.objects.get_or_create(follower=request.user, creator=creator)
        if created:
            try:
                from .atproto_sync import sync_follow_to_atproto
                sync_follow_to_atproto(follow)
            except Exception:
                logger.debug("ATProto follow sync skipped", exc_info=True)
        return Response({"detail": "Followed."}, status=status.HTTP_201_CREATED)


class UnfollowView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, username):
        deleted, _ = Follow.objects.filter(
            follower=request.user, creator__username=username
        ).delete()
        if not deleted:
            return Response(
                {"detail": "You were not following this user."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


# ─── Following list + Feed ───


class FollowingListView(generics.ListAPIView):
    """List creators the current user follows."""

    serializer_class = PublicUserSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return (
            User.objects.filter(followers__follower=self.request.user)
            .annotate(
                follower_count=Count("followers"),
                project_count=Count("projects"),
                is_following=Value(True),
            )
        )


class FeedView(generics.ListAPIView):
    """Posts from creators the current user follows."""

    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        from content.models import Post

        followed_ids = Follow.objects.filter(
            follower=self.request.user
        ).values_list("creator_id", flat=True)
        return Post.objects.filter(
            creator_id__in=followed_ids, is_published=True
        ).select_related("creator", "project")

    def get_serializer_class(self):
        from content.serializers import PostSerializer

        return PostSerializer


# ─── ATProto / Bluesky Auth ───


def _atproto_client_id(request):
    """Get the ATProto OAuth client_id.

    In production, this is a publicly accessible URL serving client metadata.
    In development, ATProto uses a special loopback client_id that embeds
    the redirect_uri and scope as query parameters:
      http://localhost?redirect_uri=<encoded>&scope=atproto
    """
    configured = getattr(django_settings, "ATPROTO_CLIENT_ID", "")
    if configured:
        return configured

    import urllib.parse
    redirect_uri = _atproto_redirect_uri(request)
    return f"http://localhost?redirect_uri={urllib.parse.quote(redirect_uri, safe='')}&scope=atproto"


def _atproto_redirect_uri(request):
    """Get the ATProto OAuth redirect_uri.

    Must use 127.0.0.1 (not localhost) per RFC 8252 for loopback clients.
    """
    configured = getattr(django_settings, "ATPROTO_REDIRECT_URI", "")
    if configured:
        return configured
    url = request.build_absolute_uri("/api/v1/accounts/atproto/callback/")
    return url.replace("://localhost", "://127.0.0.1")


class ATProtoClientMetadataView(APIView):
    """Serve the ATProto OAuth client metadata document.

    The client_id URL must serve this JSON. Bluesky's authorization server
    fetches it to verify the client.
    """
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        from .atproto_oauth import get_client_metadata

        client_id = _atproto_client_id(request)
        redirect_uri = _atproto_redirect_uri(request)
        return Response(get_client_metadata(client_id, redirect_uri))


class ATProtoAuthInitView(APIView):
    """Initiate ATProto OAuth flow.

    POST {"handle": "alice.bsky.social"}
    Returns {"authorization_url": "https://..."}

    Optionally accepts {"handle": "...", "intent": "link"} to link an
    ATProto DID to the current logged-in account instead of logging in.
    """
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        from . import atproto_oauth as oauth

        handle = request.data.get("handle", "").strip()
        if not handle:
            return Response(
                {"detail": "Handle is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        intent = request.data.get("intent", "login")
        if intent == "link" and not request.user.is_authenticated:
            return Response(
                {"detail": "Must be logged in to link an account."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        try:
            # 1. Resolve handle → DID
            did = oauth.resolve_handle(handle)

            # 2. Resolve DID → DID document → PDS URL
            did_doc = oauth.resolve_did_document(did)
            pds_url = oauth.get_pds_url(did_doc)

            # 3. Discover authorization server
            as_metadata = oauth.discover_authorization_server(pds_url)

            # 4. Generate PKCE
            code_verifier, code_challenge = oauth.generate_pkce()

            # 5. Generate DPoP key pair
            dpop_key = oauth.generate_dpop_key()

            # 6. Generate state nonce
            import secrets
            state = secrets.token_hex(16)

            # 7. Build client ID and redirect URI
            client_id = _atproto_client_id(request)
            redirect_uri = _atproto_redirect_uri(request)

            # 8. PAR (Pushed Authorization Request)
            par_endpoint = as_metadata.get("pushed_authorization_request_endpoint")
            if par_endpoint:
                request_uri = oauth.push_authorization_request(
                    as_metadata, client_id, redirect_uri,
                    code_challenge, state, handle,
                    dpop_key["private_pem"], dpop_key["jwk"],
                )
                authorization_url = oauth.build_authorization_url(
                    as_metadata, client_id, request_uri,
                )
            else:
                # Fallback: direct authorization endpoint (no PAR)
                import urllib.parse
                params = urllib.parse.urlencode({
                    "client_id": client_id,
                    "redirect_uri": redirect_uri,
                    "response_type": "code",
                    "scope": "atproto",
                    "code_challenge": code_challenge,
                    "code_challenge_method": "S256",
                    "state": state,
                    "login_hint": handle,
                })
                authorization_url = (
                    f"{as_metadata['authorization_endpoint']}?{params}"
                )

            # 9. Store OAuth state in session
            request.session["atproto_oauth"] = {
                "state": state,
                "code_verifier": code_verifier,
                "dpop_private_pem": dpop_key["private_pem"],
                "dpop_jwk": dpop_key["jwk"],
                "did": did,
                "handle": handle,
                "pds_url": pds_url,
                "as_metadata": as_metadata,
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "intent": intent,
            }

            return Response({"authorization_url": authorization_url})

        except ValueError as e:
            return Response(
                {"detail": str(e)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except Exception:
            logger.exception("ATProto auth init failed for handle=%s", handle)
            return Response(
                {"detail": "Failed to initiate Bluesky authentication."},
                status=status.HTTP_502_BAD_GATEWAY,
            )


class ATProtoCallbackView(APIView):
    """Handle the ATProto OAuth callback.

    GET ?code=...&state=...&iss=...
    Exchanges code for tokens, creates/logs in user, redirects to frontend.
    """
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        from . import atproto_oauth as oauth

        code = request.GET.get("code")
        state = request.GET.get("state")
        error = request.GET.get("error")

        frontend_url = getattr(
            django_settings, "FRONTEND_URL", "http://localhost:3000"
        )

        if error:
            error_desc = request.GET.get("error_description", error)
            return redirect(
                f"{frontend_url}/auth/atproto/callback?error={error_desc}"
            )

        if not code or not state:
            return redirect(
                f"{frontend_url}/auth/atproto/callback?error=missing_params"
            )

        # Retrieve stored OAuth state
        oauth_state = request.session.get("atproto_oauth")
        if not oauth_state:
            return redirect(
                f"{frontend_url}/auth/atproto/callback?error=session_expired"
            )

        if state != oauth_state["state"]:
            return redirect(
                f"{frontend_url}/auth/atproto/callback?error=state_mismatch"
            )

        try:
            # Exchange code for tokens
            token_data = oauth.exchange_code(
                as_metadata=oauth_state["as_metadata"],
                code=code,
                code_verifier=oauth_state["code_verifier"],
                redirect_uri=oauth_state["redirect_uri"],
                client_id=oauth_state["client_id"],
                private_pem=oauth_state["dpop_private_pem"],
                jwk=oauth_state["dpop_jwk"],
            )

            # The 'sub' claim contains the DID
            did = token_data.get("sub", oauth_state["did"])
            handle = oauth_state["handle"]
            pds_url = oauth_state["pds_url"]

            # Fetch profile for display name
            profile = oauth.get_profile(
                pds_url, did, token_data.get("access_token", ""),
                oauth_state["dpop_private_pem"], oauth_state["dpop_jwk"],
            )
            display_name = profile.get("displayName", "")

            intent = oauth_state.get("intent", "login")

            # Clean up OAuth session data
            del request.session["atproto_oauth"]

            def _save_atproto_session(target_user):
                """Persist ATProto tokens for PDS write access."""
                from .models import ATProtoSession
                ATProtoSession.objects.update_or_create(
                    user=target_user,
                    defaults={
                        "access_token": token_data.get("access_token", ""),
                        "refresh_token": token_data.get("refresh_token", ""),
                        "dpop_private_pem": oauth_state["dpop_private_pem"],
                        "dpop_jwk": oauth_state["dpop_jwk"],
                        "token_endpoint": oauth_state["as_metadata"].get("token_endpoint", ""),
                        "dpop_nonce": token_data.get("_dpop_nonce", ""),
                    },
                )

            if intent == "link":
                # Link DID to existing account
                if not request.user.is_authenticated:
                    return redirect(
                        f"{frontend_url}/auth/atproto/callback?error=not_authenticated"
                    )
                user = request.user
                # Check if DID is already linked to another account
                existing = User.objects.filter(atproto_did=did).exclude(pk=user.pk).first()
                if existing:
                    return redirect(
                        f"{frontend_url}/auth/atproto/callback?error=did_already_linked"
                    )
                user.atproto_did = did
                user.atproto_handle = handle
                user.atproto_pds_url = pds_url
                user.save(update_fields=["atproto_did", "atproto_handle", "atproto_pds_url"])
                _save_atproto_session(user)
                return redirect(
                    f"{frontend_url}/auth/atproto/callback?success=linked"
                )

            # Login flow: authenticate via ATProto backend
            user = authenticate(
                request,
                atproto_did=did,
                atproto_handle=handle,
                atproto_pds_url=pds_url,
                display_name=display_name,
            )

            if user is None:
                return redirect(
                    f"{frontend_url}/auth/atproto/callback?error=auth_failed"
                )

            login(request, user, backend="accounts.atproto_backend.ATProtoBackend")
            _save_atproto_session(user)
            return redirect(
                f"{frontend_url}/auth/atproto/callback?success=login"
            )

        except Exception:
            logger.exception("ATProto callback failed")
            return redirect(
                f"{frontend_url}/auth/atproto/callback?error=exchange_failed"
            )


class ATProtoUnlinkView(APIView):
    """Unlink ATProto identity from the current account."""
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        user = request.user
        if not user.atproto_did:
            return Response(
                {"detail": "No Bluesky account linked."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Don't allow unlinking if user has no password (ATProto-only account)
        if not user.has_usable_password():
            return Response(
                {"detail": "Cannot unlink Bluesky — it is your only login method. Set a password first."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        user.atproto_did = None
        user.atproto_handle = ""
        user.atproto_pds_url = ""
        user.save(update_fields=["atproto_did", "atproto_handle", "atproto_pds_url"])
        return Response(UserSerializer(user).data)
