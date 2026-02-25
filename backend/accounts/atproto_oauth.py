"""
ATProto OAuth 2.0 flow implementation.

Implements the AT Protocol OAuth spec:
- Handle → DID resolution
- DID → PDS discovery
- Authorization Server discovery
- PKCE (RFC 7636)
- DPoP (RFC 9449)
- PAR (RFC 9126)
- Token exchange
"""

import base64
import hashlib
import json
import logging
import os
import time
import uuid

import jwt
import requests
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

logger = logging.getLogger(__name__)

# Default resolution endpoints
PLC_DIRECTORY_URL = "https://plc.directory"
BSKY_PUBLIC_API = "https://public.api.bsky.app"


# ─── Handle & DID Resolution ───


def resolve_handle(handle: str) -> str:
    """Resolve an ATProto handle to a DID.

    Uses the public Bluesky API first, falls back to .well-known.
    """
    # Try public API
    try:
        resp = requests.get(
            f"{BSKY_PUBLIC_API}/xrpc/com.atproto.identity.resolveHandle",
            params={"handle": handle},
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            return data["did"]
    except (requests.RequestException, KeyError):
        pass

    # Fallback: HTTP .well-known
    try:
        resp = requests.get(
            f"https://{handle}/.well-known/atproto-did",
            timeout=10,
        )
        if resp.status_code == 200:
            did = resp.text.strip()
            if did.startswith("did:"):
                return did
    except requests.RequestException:
        pass

    raise ValueError(f"Could not resolve handle: {handle}")


def resolve_did_document(did: str) -> dict:
    """Resolve a DID to its DID document."""
    if did.startswith("did:plc:"):
        resp = requests.get(f"{PLC_DIRECTORY_URL}/{did}", timeout=10)
        resp.raise_for_status()
        return resp.json()

    if did.startswith("did:web:"):
        domain = did[len("did:web:"):]
        resp = requests.get(f"https://{domain}/.well-known/did.json", timeout=10)
        resp.raise_for_status()
        return resp.json()

    raise ValueError(f"Unsupported DID method: {did}")


def get_pds_url(did_document: dict) -> str:
    """Extract the PDS endpoint from a DID document."""
    for service in did_document.get("service", []):
        if service.get("type") == "AtprotoPersonalDataServer":
            return service["serviceEndpoint"]
    raise ValueError("No PDS service found in DID document")


def get_handle_from_did_document(did_document: dict) -> str:
    """Extract the handle from a DID document's alsoKnownAs."""
    for alias in did_document.get("alsoKnownAs", []):
        if alias.startswith("at://"):
            return alias[len("at://"):]
    return ""


# ─── Authorization Server Discovery ───


def discover_authorization_server(pds_url: str) -> dict:
    """Discover the OAuth authorization server for a PDS.

    Returns the full authorization server metadata.
    """
    # Get protected resource metadata
    resp = requests.get(
        f"{pds_url}/.well-known/oauth-protected-resource",
        timeout=10,
    )
    resp.raise_for_status()
    resource_meta = resp.json()

    as_url = resource_meta["authorization_servers"][0]

    # Get authorization server metadata
    resp = requests.get(
        f"{as_url}/.well-known/oauth-authorization-server",
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


# ─── PKCE ───


def generate_pkce() -> tuple[str, str]:
    """Generate PKCE code_verifier and code_challenge (S256)."""
    code_verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    digest = hashlib.sha256(code_verifier.encode()).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return code_verifier, code_challenge


# ─── DPoP Key & Proof ───


def generate_dpop_key() -> dict:
    """Generate an ES256 key pair for DPoP proofs.

    Returns dict with 'private_pem' and 'jwk' (public key as JWK).
    """
    private_key = ec.generate_private_key(ec.SECP256R1())

    private_pem = private_key.private_bytes(
        Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()
    ).decode()

    public_key = private_key.public_key()
    public_numbers = public_key.public_numbers()

    # Convert to JWK format
    def _int_to_base64url(n: int, length: int) -> str:
        return base64.urlsafe_b64encode(
            n.to_bytes(length, byteorder="big")
        ).rstrip(b"=").decode()

    jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": _int_to_base64url(public_numbers.x, 32),
        "y": _int_to_base64url(public_numbers.y, 32),
    }

    return {"private_pem": private_pem, "jwk": jwk}


def create_dpop_proof(
    method: str,
    url: str,
    private_pem: str,
    jwk: dict,
    nonce: str | None = None,
    access_token: str | None = None,
) -> str:
    """Create a DPoP proof JWT (RFC 9449)."""
    headers = {
        "typ": "dpop+jwt",
        "alg": "ES256",
        "jwk": jwk,
    }

    payload = {
        "htm": method,
        "htu": url,
        "iat": int(time.time()),
        "jti": uuid.uuid4().hex,
    }

    if nonce:
        payload["nonce"] = nonce

    if access_token:
        ath = base64.urlsafe_b64encode(
            hashlib.sha256(access_token.encode()).digest()
        ).rstrip(b"=").decode()
        payload["ath"] = ath

    return jwt.encode(payload, private_pem, algorithm="ES256", headers=headers)


# ─── PAR (Pushed Authorization Request) ───


def push_authorization_request(
    as_metadata: dict,
    client_id: str,
    redirect_uri: str,
    code_challenge: str,
    state: str,
    login_hint: str,
    private_pem: str,
    jwk: dict,
    dpop_nonce: str | None = None,
) -> str:
    """Push an authorization request and return the request_uri.

    Handles DPoP nonce requirement automatically (server sends nonce
    on first attempt, we retry with it).
    """
    par_endpoint = as_metadata.get("pushed_authorization_request_endpoint")
    if not par_endpoint:
        raise ValueError("Authorization server does not support PAR")

    dpop_proof = create_dpop_proof(
        "POST", par_endpoint, private_pem, jwk, nonce=dpop_nonce,
    )

    resp = requests.post(
        par_endpoint,
        data={
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "atproto",
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "state": state,
            "login_hint": login_hint,
        },
        headers={"DPoP": dpop_proof},
        timeout=15,
    )

    # Handle DPoP nonce requirement
    if resp.status_code == 400:
        error_data = resp.json()
        if error_data.get("error") == "use_dpop_nonce":
            new_nonce = resp.headers.get("DPoP-Nonce")
            if new_nonce and not dpop_nonce:
                return push_authorization_request(
                    as_metadata, client_id, redirect_uri, code_challenge,
                    state, login_hint, private_pem, jwk, dpop_nonce=new_nonce,
                )
        raise ValueError(
            f"PAR failed: {error_data.get('error_description', error_data.get('error', 'unknown'))}"
        )

    resp.raise_for_status()
    data = resp.json()
    return data["request_uri"]


# ─── Token Exchange ───


def exchange_code(
    as_metadata: dict,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    client_id: str,
    private_pem: str,
    jwk: dict,
    dpop_nonce: str | None = None,
) -> dict:
    """Exchange authorization code for tokens.

    Returns token response dict with access_token, token_type, sub, etc.
    Handles DPoP nonce retry automatically.
    """
    token_endpoint = as_metadata["token_endpoint"]

    dpop_proof = create_dpop_proof(
        "POST", token_endpoint, private_pem, jwk, nonce=dpop_nonce,
    )

    resp = requests.post(
        token_endpoint,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
            "client_id": client_id,
        },
        headers={"DPoP": dpop_proof},
        timeout=15,
    )

    # Handle DPoP nonce requirement (server returns 400 with use_dpop_nonce error)
    if resp.status_code == 400:
        error_data = resp.json()
        if error_data.get("error") == "use_dpop_nonce":
            new_nonce = resp.headers.get("DPoP-Nonce")
            if new_nonce:
                return exchange_code(
                    as_metadata, code, code_verifier, redirect_uri,
                    client_id, private_pem, jwk, dpop_nonce=new_nonce,
                )

    if resp.status_code != 200:
        error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        raise ValueError(
            f"Token exchange failed ({resp.status_code}): "
            f"{error_data.get('error_description', error_data.get('error', resp.text))}"
        )

    token_data = resp.json()

    # Store the DPoP nonce for future requests if provided
    dpop_nonce_header = resp.headers.get("DPoP-Nonce")
    if dpop_nonce_header:
        token_data["_dpop_nonce"] = dpop_nonce_header

    return token_data


# ─── Build Authorization URL ───


def build_authorization_url(
    as_metadata: dict,
    client_id: str,
    request_uri: str,
) -> str:
    """Build the full authorization URL for user redirect."""
    auth_endpoint = as_metadata["authorization_endpoint"]
    params = f"client_id={client_id}&request_uri={request_uri}"
    separator = "&" if "?" in auth_endpoint else "?"
    return f"{auth_endpoint}{separator}{params}"


# ─── Client Metadata ───


def get_client_metadata(client_id: str, redirect_uri: str) -> dict:
    """Generate ATProto OAuth client metadata document."""
    return {
        "client_id": client_id,
        "client_name": "Bluebell",
        "client_uri": client_id.rsplit("/api/", 1)[0] if "/api/" in client_id else client_id,
        "redirect_uris": [redirect_uri],
        "scope": "atproto",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "web",
        "dpop_bound_access_tokens": True,
    }


# ─── ATProto API Calls ───


def get_profile(pds_url: str, did: str, access_token: str, private_pem: str, jwk: dict, dpop_nonce: str | None = None) -> dict:
    """Fetch a user's profile from their PDS."""
    url = f"{BSKY_PUBLIC_API}/xrpc/app.bsky.actor.getProfile"

    # Use public API (no auth needed for public profiles)
    resp = requests.get(
        url,
        params={"actor": did},
        timeout=10,
    )

    if resp.status_code == 200:
        return resp.json()

    return {"did": did, "handle": "", "displayName": ""}
