import { Hono } from 'hono';
import {
  getAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  getAutomationLogs,
  getAutomationActions,
  createAutomationAction,
  updateAutomationAction,
  deleteAutomationAction,
} from '@line-crm/db';
import type { AutomationActionRow } from '@line-crm/db';
import type { Env } from '../index.js';

const automations = new Hono<Env>();

// ========== 自動化ルールCRUD ==========

automations.get('/api/automations', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    let items;
    if (lineAccountId) {
      const result = await c.env.DB
        .prepare(`SELECT * FROM automations WHERE line_account_id = ? ORDER BY priority DESC, created_at DESC`)
        .bind(lineAccountId)
        .all();
      items = result.results as unknown as Awaited<ReturnType<typeof getAutomations>>;
    } else {
      items = await getAutomations(c.env.DB);
    }
    return c.json({
      success: true,
      data: items.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        eventType: a.event_type,
        conditions: JSON.parse(a.conditions),
        actions: JSON.parse(a.actions),
        isActive: Boolean(a.is_active),
        priority: a.priority,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/automations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.get('/api/automations/:id', async (c) => {
  try {
    const item = await getAutomationById(c.env.DB, c.req.param('id'));
    if (!item) return c.json({ success: false, error: 'Automation not found' }, 404);

    // ログも取得
    const logs = await getAutomationLogs(c.env.DB, item.id, 50);

    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        description: item.description,
        eventType: item.event_type,
        conditions: JSON.parse(item.conditions),
        actions: JSON.parse(item.actions),
        isActive: Boolean(item.is_active),
        priority: item.priority,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        logs: logs.map((l) => ({
          id: l.id,
          friendId: l.friend_id,
          eventData: l.event_data ? JSON.parse(l.event_data) : null,
          actionsResult: l.actions_result ? JSON.parse(l.actions_result) : null,
          status: l.status,
          createdAt: l.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/automations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.post('/api/automations', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      description?: string;
      eventType: string;
      conditions?: Record<string, unknown>;
      actions: unknown[];
      priority?: number;
      lineAccountId?: string | null;
    }>();
    if (!body.name || !body.eventType || !body.actions) {
      return c.json({ success: false, error: 'name, eventType, actions are required' }, 400);
    }
    const item = await createAutomation(c.env.DB, body);
    // Save line_account_id if provided
    if (body.lineAccountId) {
      await c.env.DB.prepare(`UPDATE automations SET line_account_id = ? WHERE id = ?`)
        .bind(body.lineAccountId, item.id).run();
    }
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        eventType: item.event_type,
        actions: JSON.parse(item.actions),
        isActive: Boolean(item.is_active),
        priority: item.priority,
        createdAt: item.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/automations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.put('/api/automations/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await updateAutomation(c.env.DB, id, body);
    const updated = await getAutomationById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        eventType: updated.event_type,
        conditions: JSON.parse(updated.conditions),
        actions: JSON.parse(updated.actions),
        isActive: Boolean(updated.is_active),
        priority: updated.priority,
      },
    });
  } catch (err) {
    console.error('PUT /api/automations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.delete('/api/automations/:id', async (c) => {
  try {
    await deleteAutomation(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/automations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== オートメーションアクションCRUD ==========

function mapAction(r: AutomationActionRow) {
  return {
    id: r.id,
    automationId: r.automation_id,
    stepOrder: r.step_order,
    actionType: r.action_type,
    params: JSON.parse(r.params) as Record<string, unknown>,
    conditionJson: r.condition_json ? JSON.parse(r.condition_json) as Record<string, unknown> : null,
    onError: r.on_error,
    isActive: Boolean(r.is_active),
    label: r.label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

automations.get('/api/automations/:id/actions', async (c) => {
  try {
    const rows = await getAutomationActions(c.env.DB, c.req.param('id'), false);
    return c.json({ success: true, data: rows.map(mapAction) });
  } catch (err) {
    console.error('GET /api/automations/:id/actions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.post('/api/automations/:id/actions', async (c) => {
  try {
    const automationId = c.req.param('id');
    const body = await c.req.json<{
      actionType: string;
      params?: Record<string, unknown>;
      conditionJson?: Record<string, unknown> | null;
      onError?: 'continue' | 'abort';
      label?: string;
      stepOrder?: number;
    }>();
    if (!body.actionType) {
      return c.json({ success: false, error: 'actionType is required' }, 400);
    }
    // Append at end by default
    let stepOrder = body.stepOrder;
    if (stepOrder === undefined) {
      const existing = await getAutomationActions(c.env.DB, automationId);
      stepOrder = existing.length;
    }
    const row = await createAutomationAction(c.env.DB, {
      automationId,
      stepOrder,
      actionType: body.actionType,
      params: body.params ?? {},
      conditionJson: body.conditionJson ?? null,
      onError: body.onError ?? 'continue',
      label: body.label,
    });
    return c.json({ success: true, data: mapAction(row) }, 201);
  } catch (err) {
    console.error('POST /api/automations/:id/actions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.put('/api/automations/:id/actions/:actionId', async (c) => {
  try {
    const actionId = c.req.param('actionId');
    const body = await c.req.json<{
      actionType?: string;
      params?: Record<string, unknown>;
      conditionJson?: Record<string, unknown> | null;
      onError?: 'continue' | 'abort';
      label?: string;
      stepOrder?: number;
      isActive?: boolean;
    }>();
    await updateAutomationAction(c.env.DB, actionId, {
      actionType: body.actionType,
      params: body.params,
      conditionJson: body.conditionJson !== undefined ? body.conditionJson : undefined,
      onError: body.onError,
      label: body.label,
      stepOrder: body.stepOrder,
      isActive: body.isActive,
    });
    const updated = await c.env.DB
      .prepare('SELECT * FROM automation_actions WHERE id = ?')
      .bind(actionId)
      .first<AutomationActionRow>();
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: mapAction(updated) });
  } catch (err) {
    console.error('PUT /api/automations/:id/actions/:actionId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.delete('/api/automations/:id/actions/:actionId', async (c) => {
  try {
    await deleteAutomationAction(c.env.DB, c.req.param('actionId'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/automations/:id/actions/:actionId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 自動化ログ ==========

automations.get('/api/automations/:id/logs', async (c) => {
  try {
    const automationId = c.req.param('id');
    const limit = Number(c.req.query('limit') ?? '100');
    const logs = await getAutomationLogs(c.env.DB, automationId, limit);
    return c.json({
      success: true,
      data: logs.map((l) => ({
        id: l.id,
        automationId: l.automation_id,
        friendId: l.friend_id,
        eventData: l.event_data ? JSON.parse(l.event_data) : null,
        actionsResult: l.actions_result ? JSON.parse(l.actions_result) : null,
        status: l.status,
        createdAt: l.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/automations/:id/logs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { automations };
