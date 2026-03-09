import { hc } from "hono/client";
import type { AppType } from "../../../api/src/index.js";

const baseUrl =
	typeof location !== "undefined" &&
	(location.hostname === "localhost" || location.hostname === "127.0.0.1")
		? "http://localhost:8000"
		: "";

export const client = hc<AppType>(baseUrl, {
	init: {
		credentials: "include", // Send cookies for session auth
	},
});
