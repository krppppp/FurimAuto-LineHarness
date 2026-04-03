import { Hono } from 'hono';
import {
  getEntryRoutes,
  getEntryRouteByRefCode,
  createEntryRoute,
  updateEntryRoute,
  deleteEntryRoute,
  getRefTrackingStats,
} from '@line-crm/db';
import type { Env } from '../index.js';

const entryRoutes = new Hono<Env>();

function serializeRoute(row: {
  id: string;
  ref_code: string;
  name: string;
  tag_id: string | null;
  scenario_id: string | null;
  redirect_url: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    refCode: row.ref_code,
    name: row.name,
    tagId: row.tag_id,
    scenarioId: row.scenario_id,
    redirectUrl: row.redirect_url,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/entry-routes
entryRoutes.get('/api/entry-routes', async (c) => {
  try {
    const items = await getEntryRoutes(c.env.DB);
    return c.json({ success: true, data: items.map(serializeRoute) });
  } catch (err) {
    console.error('GET /api/entry-routes error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/entry-routes/:id
entryRoutes.get('/api/entry-routes/:id', async (c) => {
  try {
    const item = await c.env.DB
      .prepare('SELECT * FROM entry_routes WHERE id = ?')
      .bind(c.req.param('id'))
      .first<Parameters<typeof serializeRoute>[0]>();
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    const stats = await getRefTrackingStats(c.env.DB, item.ref_code);
    return c.json({ success: true, data: { ...serializeRoute(item), trackingCount: stats.count } });
  } catch (err) {
    console.error('GET /api/entry-routes/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/entry-routes
entryRoutes.post('/api/entry-routes', async (c) => {
  try {
    const body = await c.req.json<{
      refCode: string;
      name: string;
      tagId?: string | null;
      scenarioId?: string | null;
      redirectUrl?: string | null;
      isActive?: boolean;
    }>();
    if (!body.refCode || !body.name) {
      return c.json({ success: false, error: 'refCode and name are required' }, 400);
    }
    const item = await createEntryRoute(c.env.DB, {
      refCode: body.refCode,
      name: body.name,
      tagId: body.tagId ?? null,
      scenarioId: body.scenarioId ?? null,
      redirectUrl: body.redirectUrl ?? null,
      isActive: body.isActive !== false,
    });
    return c.json({ success: true, data: serializeRoute(item) }, 201);
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('UNIQUE')) {
      return c.json({ success: false, error: 'ref_code already exists' }, 409);
    }
    console.error('POST /api/entry-routes error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/entry-routes/:id
entryRoutes.patch('/api/entry-routes/:id', async (c) => {
  try {
    const body = await c.req.json<{
      refCode?: string;
      name?: string;
      tagId?: string | null;
      scenarioId?: string | null;
      redirectUrl?: string | null;
      isActive?: boolean;
    }>();
    const item = await updateEntryRoute(c.env.DB, c.req.param('id'), {
      refCode: body.refCode,
      name: body.name,
      tagId: body.tagId,
      scenarioId: body.scenarioId,
      redirectUrl: body.redirectUrl,
      isActive: body.isActive,
    });
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serializeRoute(item) });
  } catch (err) {
    console.error('PATCH /api/entry-routes/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/entry-routes/:id
entryRoutes.delete('/api/entry-routes/:id', async (c) => {
  try {
    await deleteEntryRoute(c.env.DB, c.req.param('id'));
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/entry-routes/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/entry-routes/by-ref/:refCode
entryRoutes.get('/api/entry-routes/by-ref/:refCode', async (c) => {
  try {
    const item = await getEntryRouteByRefCode(c.env.DB, c.req.param('refCode'));
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serializeRoute(item) });
  } catch (err) {
    console.error('GET /api/entry-routes/by-ref/:refCode error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { entryRoutes };
