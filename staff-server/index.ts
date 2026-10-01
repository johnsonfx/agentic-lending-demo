/**
 * The staff portal's backend — session-based OIDC against Keycloak, and a
 * thin REST API in front of the staff MCP tools (mcpClient.ts). Its own
 * process, its own port, mirroring the orchestrator/mcp-server split: this
 * is a genuinely different concern (a human's browser session) from either
 * the customer chat or the tool layer, and Keycloak is a dependency the
 * core customer demo has never had — keeping it a separate process means a
 * missing Keycloak container only ever breaks this one.
 *
 * Confidential client, Authorization Code flow: this server holds the
 * client secret and does the token exchange itself, so there's no PKCE-in-
 * the-browser complexity and no token ever reaches client-side JS. The
 * session holds the token set; the signed-in user's own access token is
 * what's forwarded to the MCP server on every call (see mcpClient.ts) — so
 * resolve_referral's reviewer identity, several hops downstream, still
 * traces back to a real Keycloak login, not to this server's own service
 * identity.
 */

import "dotenv/config";
import express from "express";
import session from "express-session";
import * as oidc from "openid-client";
import { listApplications, getApplicationDetail, resolveReferral } from "./mcpClient.js";

const PORT = Number(process.env.STAFF_PORT || 8791);
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || "http://localhost:8080";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "agentic-lending";
const CLIENT_ID = process.env.STAFF_CLIENT_ID || "staff-portal";
const CLIENT_SECRET = process.env.STAFF_CLIENT_SECRET;
const SESSION_SECRET = process.env.STAFF_SESSION_SECRET;
const CALLBACK_URL = process.env.STAFF_CALLBACK_URL || `http://localhost:${PORT}/auth/callback`;
// Where the staff SPA is served from in dev (vite.staff.config.js) — only
// used to send the browser back somewhere sensible after login/logout.
const CLIENT_ORIGIN = process.env.STAFF_CLIENT_ORIGIN || "http://localhost:5174";

if (!CLIENT_SECRET) throw new Error("STAFF_CLIENT_SECRET is required — see .env.example.");
if (!SESSION_SECRET) throw new Error("STAFF_SESSION_SECRET is required — see .env.example.");

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number; // epoch ms
}

declare module "express-session" {
  interface SessionData {
    oauthState?: string;
    oauthNonce?: string;
    postLoginRedirect?: string;
    tokens?: TokenSet;
    username?: string;
  }
}

const app = express();
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // In-memory store — same demo-grade, single-instance choice this app
    // already makes for SQLite; a real deployment wants a shared store
    // (Redis, the DB) the moment there's more than one staff-server process.
    cookie: { httpOnly: true, sameSite: "lax", secure: false },
  })
);

let oidcConfig: oidc.Configuration | null = null;
async function getOidcConfig(): Promise<oidc.Configuration> {
  if (oidcConfig) return oidcConfig;
  oidcConfig = await oidc.discovery(
    new URL(`${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`),
    CLIENT_ID,
    CLIENT_SECRET,
    undefined,
    // openid-client defaults to refusing HTTP entirely. The local dev
    // Keycloak (docker-compose.yml) deliberately has no TLS in front of it
    // — see that file's header — so discovery and every later request need
    // this opt-in. A real deployment's Keycloak is HTTPS and drops this.
    { execute: [oidc.allowInsecureRequests] }
  );
  return oidcConfig;
}

app.get("/auth/login", async (req, res) => {
  const config = await getOidcConfig();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  req.session.oauthState = state;
  req.session.oauthNonce = nonce;
  req.session.postLoginRedirect = typeof req.query.redirect === "string" ? req.query.redirect : "/";

  const authUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: CALLBACK_URL,
    scope: "openid profile email",
    state,
    nonce,
  });
  res.redirect(authUrl.href);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const config = await getOidcConfig();
    const currentUrl = new URL(req.originalUrl, `http://localhost:${PORT}`);
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      expectedState: req.session.oauthState,
      expectedNonce: req.session.oauthNonce,
    });
    delete req.session.oauthState;
    delete req.session.oauthNonce;

    req.session.tokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresAt: Date.now() + tokens.expiresIn() * 1000,
    };
    req.session.username =
      typeof tokens.claims()?.preferred_username === "string" ? (tokens.claims()!.preferred_username as string) : undefined;

    const dest = req.session.postLoginRedirect || "/";
    delete req.session.postLoginRedirect;
    res.redirect(`${CLIENT_ORIGIN}${dest}`);
  } catch (e) {
    console.error("auth callback failed:", (e as Error).message);
    res.status(401).send("Sign-in failed. Close this tab and try again.");
  }
});

app.get("/auth/logout", async (req, res) => {
  const config = await getOidcConfig();
  const idToken = req.session.tokens?.idToken;
  req.session.destroy(() => {
    const endSessionUrl = oidc.buildEndSessionUrl(config, {
      post_logout_redirect_uri: CLIENT_ORIGIN,
      ...(idToken ? { id_token_hint: idToken } : {}),
    });
    res.redirect(endSessionUrl.href);
  });
});

app.get("/auth/me", (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, username: req.session.username });
});

/**
 * Returns a currently-valid access token for this session, refreshing it
 * first if it's within 30s of expiry. Every /api route goes through this
 * rather than reading req.session.tokens directly, so a call never carries
 * a token that's about to be rejected mid-flight by the MCP server.
 */
async function currentAccessToken(req: express.Request): Promise<string | null> {
  const tokens = req.session.tokens;
  if (!tokens) return null;
  if (tokens.expiresAt > Date.now() + 30_000) return tokens.accessToken;
  if (!tokens.refreshToken) return null;

  try {
    const config = await getOidcConfig();
    const refreshed = await oidc.refreshTokenGrant(config, tokens.refreshToken);
    req.session.tokens = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
      idToken: refreshed.id_token ?? tokens.idToken,
      expiresAt: Date.now() + refreshed.expiresIn() * 1000,
    };
    return refreshed.access_token;
  } catch {
    return null; // refresh token itself expired — the requireAuth guard below sends them back to /auth/login
  }
}

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const token = await currentAccessToken(req);
  if (!token) {
    res.status(401).json({ error: "UNAUTHENTICATED" });
    return;
  }
  (req as express.Request & { accessToken: string }).accessToken = token;
  next();
}

const api = express.Router();
api.use(requireAuth);

api.get("/applications", async (req, res) => {
  const token = (req as express.Request & { accessToken: string }).accessToken;
  const status = req.query.status as "PENDING" | "RESOLVED" | "ALL" | undefined;
  try {
    res.json(await listApplications(token, status));
  } catch (e) {
    res.status(502).json({ error: "MCP_CALL_FAILED", detail: (e as Error).message });
  }
});

api.get("/applications/:id", async (req, res) => {
  const token = (req as express.Request & { accessToken: string }).accessToken;
  try {
    const detail = await getApplicationDetail(token, req.params.id);
    if (detail && typeof detail === "object" && "error" in detail) return res.status(404).json(detail);
    res.json(detail);
  } catch (e) {
    res.status(502).json({ error: "MCP_CALL_FAILED", detail: (e as Error).message });
  }
});

api.post("/applications/:id/resolve", async (req, res) => {
  const token = (req as express.Request & { accessToken: string }).accessToken;
  const { decision, notes } = req.body ?? {};
  if (decision !== "UPHOLD" && decision !== "OVERTURN")
    return res.status(400).json({ error: "BAD_INPUT", detail: 'decision must be "UPHOLD" or "OVERTURN".' });
  try {
    const result = await resolveReferral(token, req.params.id, decision, typeof notes === "string" ? notes : null);
    if (result && typeof result === "object" && "error" in result) return res.status(409).json(result);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: "MCP_CALL_FAILED", detail: (e as Error).message });
  }
});

app.use("/api", api);

// Fail fast: an unreachable Keycloak stops this process at boot, the same
// shape server/index.ts uses for its own config/MCP dependencies — but see
// this file's own header for why that must never take the customer
// orchestrator down with it.
getOidcConfig()
  .then(() => {
    app.listen(PORT, () => console.log(`staff portal api on http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error("Fatal: could not start staff-server — is Keycloak running (docker compose up -d)? —", (e as Error).message);
    process.exit(1);
  });
