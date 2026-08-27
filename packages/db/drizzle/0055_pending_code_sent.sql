-- Holding an address and having mailed it are different facts. The Bluesky door reaches the
-- finishing page with no address — the PDS supplies one at the OAuth callback, after the only
-- place that sends the first code — so a page choosing its state on `email` alone claimed to
-- have sent a code nothing had ever sent.
ALTER TABLE "pending_signups" ADD COLUMN "code_sent_at" timestamp with time zone;