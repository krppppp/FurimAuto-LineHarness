import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  ADMIN_AUTH_COOKIE,
  CSRF_COOKIE,
  adminSessionCookie,
  authenticateApiToken,
  cookieSessionToken,
  csrfCookie,
  csrfTokenFromCookie,
  expiredCookie,
} from '../middleware/auth.js';
import { resolveAdminAuthConfig } from '../middleware/admin-auth-config.js';

export const adminAuth = new Hono<Env>();

/**
 * POST /api/auth/login
 *
 * Validates the API key, then issues:
 *   - lh_admin_session (HttpOnly) — the credential, never exposed to JS.
 *   - lh_csrf (readable) — the double-submit CSRF token, also returned in the
 *     body so a cross-site SPA (which cannot read the API's cookie) can echo it
 *     back via the X-CSRF-Token header.
 *
 * Refuses with a clear error when the topology cannot deliver the cookie,
 * turning the silent "login breaks after deploy" failure into an actionable
 * configuration error.
 */
adminAuth.post('/api/auth/login', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (config.misconfigured) {
    console.error('[admin-auth] refused login — misconfigured topology:', config.misconfigured);
    return c.json({ success: false, error: config.misconfigured }, 500);
  }

  const body = await c.req
    .json<{ apiKey?: string }>()
    .catch(() => ({}) as { apiKey?: string });
  const apiKey = body.apiKey?.trim() ?? '';
  const staff = await authenticateApiToken(c, apiKey || null);

  if (!staff) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const csrfToken = crypto.randomUUID();
  c.header('Set-Cookie', adminSessionCookie(apiKey, config.sameSite), { append: true });
  c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
  return c.json({ success: true, data: staff, csrfToken });
});

/**
 * POST /api/auth/logout — clears both cookies. No CSRF required: clearing your
 * own session is not a meaningful CSRF target, and this keeps logout resilient
 * even if the CSRF token was lost client-side.
 */
adminAuth.post('/api/auth/logout', async (c) => {
  const { sameSite } = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  c.header('Set-Cookie', expiredCookie(ADMIN_AUTH_COOKIE, sameSite), { append: true });
  c.header('Set-Cookie', expiredCookie(CSRF_COOKIE, sameSite), { append: true });
  return c.json({ success: true, data: null });
});

/**
 * GET /api/auth/session — returns the authenticated staff (set by the auth
 * middleware) plus the current CSRF token, minting the CSRF token if it is
 * missing (e.g. after a reload that dropped the in-memory token). This lets the
 * SPA recover the CSRF token without forcing a re-login.
 *
 * For cookie-authenticated calls both cookies are re-issued with their current
 * values and a fresh Max-Age, so the session slides as long as the admin UI is
 * opened. Bearer callers get no cookies.
 */
adminAuth.get('/api/auth/session', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  const sessionToken = cookieSessionToken(c);
  let csrfToken = csrfTokenFromCookie(c);
  if (!csrfToken) {
    csrfToken = crypto.randomUUID();
    if (!sessionToken) {
      c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
    }
  }
  if (sessionToken) {
    c.header('Set-Cookie', adminSessionCookie(sessionToken, config.sameSite), { append: true });
    c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
  }
  return c.json({ success: true, data: c.get('staff'), csrfToken });
});
