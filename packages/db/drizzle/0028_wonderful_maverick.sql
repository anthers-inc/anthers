-- Unwind the P2P delivery architecture (2026-08-11).
--
-- 🚨 IRREVERSIBLE. `p2p_manifest` held every asset's per-chunk SHA-256 set, built by one
-- full pass over the object. Dropping the column discards work that can only be redone by
-- re-hashing every asset in storage. Parker chose the clean break knowingly; a dev backup
-- was taken first (see the PR).
--
-- Downloads return to access-checked signed URLs served by Anthers. Creator-hosted
-- delivery continues as a node API plus a setup playbook, not as a peer protocol.
--
-- `p2p_peers` (migration 0027) held announced peer origins and lived for one day. Nothing
-- but the discovery endpoints ever read it, so CASCADE removes only its own indexes and
-- foreign keys.

DROP TABLE "p2p_peers" CASCADE;--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "p2p_manifest";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "p2p_manifest_built_at";