import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { csrfProtection } from "./middleware/csrf.js";
import { authRoutes } from "./routes/auth.js";
import { atprotoRoutes } from "./routes/atproto.js";
import { accountRoutes } from "./routes/accounts.js";
import { contentRoutes } from "./routes/content.js";
import { paymentRoutes } from "./routes/payments.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { integrationRoutes } from "./routes/integrations.js";
import { jamRoutes } from "./routes/jams.js";

const app = new Hono()
	.use(logger())
	.use(secureHeaders())
	.use(
		cors({
			origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
			credentials: true,
		}),
	)
	.use(csrfProtection)
	.get("/health", (c) => c.json({ status: "ok" }))
	.route("/api/auth", authRoutes)
	.route("/api/atproto", atprotoRoutes)
	.route("/api/accounts", accountRoutes)
	.route("/api/content", contentRoutes)
	.route("/api/payments", paymentRoutes)
	.route("/api/subscriptions", subscriptionRoutes)
	.route("/api/integrations", integrationRoutes)
	.route("/api/jams", jamRoutes);

export default {
	port: Number(process.env.PORT ?? 8000),
	fetch: app.fetch,
};

export type AppType = typeof app;
