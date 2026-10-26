#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Move one identity onto this node with goat, then record it as hosted.
#
# goat is Bluesky's own migration tool and carries the three documented categories: the
# repository CAR, the private preferences, and the public blobs, then the identity. What it
# cannot do is tell Anthers that the identity now lives here — the app resolves every space
# write through a `hosted_accounts` row with a sealed password, and signup is the only other
# thing that writes one. `hosted:record` closes that gap, and it runs here with the same
# password goat just set, so the secret exists only inside this process.
#
#   GOAT_EMAIL=you@example.com ./scripts/move-account-to-node.sh <user-id> <handle>
#
# A person runs this, not an agent: goat needs the account's real password on the old PDS,
# and that value is read here and never printed, never passed as an argument, and never
# written to a file.
#
#   - BSKY_ANTHERS_ORG_PASSWORD  the account's password at the PDS hosting it now, which is
#                                Bluesky's credential rather than an Anthers one; optional,
#                                and the script prompts for it when unset
#   - GOAT_EMAIL                 the address for the account on this node
#
# ⚠️ goat keeps its session token in cleartext under the home directory. The script logs out
# at the end to wipe it, on the same reasoning as the tool's own README.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_ID="${1:?usage: $0 <user-id> <handle>}"
HANDLE="${2:?usage: $0 <user-id> <handle>}"
: "${GOAT_EMAIL:?set GOAT_EMAIL to the address this account should carry on the node}"

NODE_URL="https://anthers.social"
SITE_URL="https://anthers.org"

command -v goat >/dev/null || { echo "goat is not installed" >&2; exit 1; }

if [ -z "${BSKY_ANTHERS_ORG_PASSWORD:-}" ]; then
	read -r -s -p "Password for ${HANDLE} on its current PDS: " BSKY_ANTHERS_ORG_PASSWORD
	echo
fi

export GOAT_USERNAME="$HANDLE"
export GOAT_PASSWORD="$BSKY_ANTHERS_ORG_PASSWORD"
export ATP_PDS_HOST="$NODE_URL"
export NEW_ACCOUNT_HANDLE="$HANDLE"
export HOSTED_PDS_URL="$NODE_URL"
# The network guard refuses a real host unless the deployment looks public, and an https
# FRONTEND_URL is what that detection reads.
export FRONTEND_URL="$SITE_URL"

# A session goat stored earlier is reused when GOAT_SKIP_LOGIN is set: logging in again is a
# second createSession against the old PDS, and one that failed with a 401 while the stored
# session and a direct call with the same password both worked.
if [ -z "${GOAT_SKIP_LOGIN:-}" ]; then
	echo "-> signing in to ${HANDLE}'s current PDS"
	goat account login
fi

if [ -z "${PLC_SIGN_TOKEN:-}" ]; then
	echo "-> asking that PDS to email a PLC signature token"
	goat account plc request-token
	read -r -s -p "PLC token from the email: " PLC_SIGN_TOKEN
	echo
fi
export PLC_SIGN_TOKEN

# ⚠️ **This is the node's credential for the account, not a way to sign in to Anthers.** Anthers
# accounts have no passwords at all: sign-in is an emailed code. A repo host authenticates its
# accounts with identifier and password, so one is minted here for the node and sealed under
# HOSTED_ACCOUNT_KEY. Nobody is shown it; the app uses it only to act for the account. Losing
# it is recoverable with the node's admin password, by hand, one account at a time.
NEW_ACCOUNT_PASSWORD="$(openssl rand -base64 24)"
export NEW_ACCOUNT_PASSWORD

# ⚠️ **The invite code is the one value goat takes only as an argument.** The node requires one
# to create an account, and the tool offers no environment source; a single-use code minted for
# this call is the smallest exposure available. Set INVITE_CODE to supply it.
echo "-> moving the account to ${NODE_URL}"
goat account migrate --new-email "$GOAT_EMAIL" ${INVITE_CODE:+--invite-code "$INVITE_CODE"}

echo "-> what the network now resolves"
goat resolve "$HANDLE"

echo "-> recording the identity as hosted"
cd "$ROOT"
HOSTED_RECORD_PASSWORD="$NEW_ACCOUNT_PASSWORD" \
	HOSTED_PDS_URL="$NODE_URL" \
	FRONTEND_URL="$SITE_URL" \
	make prod-db CMD="bun run hosted:record --user ${USER_ID}"

echo "-> logging goat out"
goat account logout

cat <<EOF

Moved and recorded. What remains is the node's own bookkeeping:
  - restart the PDS so the boot backfill publishes the new host's #atproto_kem key
  - run: bun run space:migrate-reader --user ${USER_ID}
EOF
