# SPDX-License-Identifier: Apache-2.0
# The private AT Protocol network `network.mjs` describes. Built and run by `scripts/session.ts`.
#
# The full Node image rather than `-slim`, because `better-sqlite3` falls back to compiling itself
# when no prebuilt binary matches, and the slim image has no compiler to do it with.
FROM node:24

WORKDIR /network
# Installed from the lockfile beside this file, which CI installs from too — so the network a test
# run gets is the same everywhere and changes only when that lockfile does.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY network.mjs ./
CMD ["node", "network.mjs"]
