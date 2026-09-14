# SPDX-License-Identifier: Apache-2.0
# The private AT Protocol network `network.mjs` describes. Built and run by `make pds-up`.
#
# The full Node image rather than `-slim`, because `better-sqlite3` falls back to compiling itself
# when no prebuilt binary matches, and the slim image has no compiler to do it with.
FROM node:24

WORKDIR /network
# Pinned exactly, so the network a test run gets does not change underneath it between builds.
RUN npm init -y >/dev/null \
	&& npm pkg set type=module \
	&& npm install --no-audit --no-fund @atproto/dev-env@0.6.7

COPY network.mjs ./
EXPOSE 2582 2583
CMD ["node", "network.mjs"]
