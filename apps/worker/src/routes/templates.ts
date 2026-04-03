import { Hono } from 'hono';
import {
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getTemplateMessages,
  addMessageToTemplate,
  removeMessageFromTemplate,
} from '@line-crm/db';
import type { Env } from '../index.js';

const templates = new Hono<Env>();

function serializeTemplate(t: { id: string; name: string; category: string; categories: string; message_type: string; message_content: string; created_at: string; updated_at: string }) {
  let cats: string[] = [];
  try { cats = JSON.parse(t.categories ?? '[]') as string[]; } catch { /* ignore */ }
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    categories: cats,
    messageType: t.message_type,
    messageContent: t.message_content,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

templates.get('/api/templates', async (c) => {
  try {
    const category = c.req.query('category') ?? undefined;
    const items = await getTemplates(c.env.DB, category);
    return c.json({ success: true, data: items.map(serializeTemplate) });
  } catch (err) {
    console.error('GET /api/templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.get('/api/templates/:id', async (c) => {
  try {
    const item = await getTemplateById(c.env.DB, c.req.param('id'));
    if (!item) return c.json({ success: false, error: 'Template not found' }, 404);
    return c.json({ success: true, data: serializeTemplate(item) });
  } catch (err) {
    console.error('GET /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.post('/api/templates', async (c) => {
  try {
    const body = await c.req.json<{ name: string; categories?: string[]; messageType?: string; messageContent?: string }>();
    if (!body.name) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }
    const item = await createTemplate(c.env.DB, {
      name: body.name,
      categories: body.categories ?? [],
      messageType: body.messageType,
      messageContent: body.messageContent,
    });
    return c.json({ success: true, data: serializeTemplate(item) }, 201);
  } catch (err) {
    console.error('POST /api/templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.put('/api/templates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Partial<{ name: string; categories: string[]; messageType: string; messageContent: string }>>();
    await updateTemplate(c.env.DB, id, {
      name: body.name,
      categories: body.categories,
      messageType: body.messageType,
      messageContent: body.messageContent,
    });
    const updated = await getTemplateById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serializeTemplate(updated) });
  } catch (err) {
    console.error('PUT /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.delete('/api/templates/:id', async (c) => {
  try {
    await deleteTemplate(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── template_messages エンドポイント ──────────────────────────────────────

templates.get('/api/templates/:id/messages', async (c) => {
  try {
    const items = await getTemplateMessages(c.env.DB, c.req.param('id'));
    return c.json({
      success: true,
      data: items.map((tm) => ({
        id: tm.id,
        templateId: tm.template_id,
        messageId: tm.message_id,
        stepOrder: tm.step_order,
        createdAt: tm.created_at,
        message: {
          id: tm.message.id,
          messageType: tm.message.message_type,
          content: tm.message.content,
          altText: tm.message.alt_text,
          tags: JSON.parse(tm.message.tags) as string[],
          label: tm.message.label,
        },
      })),
    });
  } catch (err) {
    console.error('GET /api/templates/:id/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.post('/api/templates/:id/messages', async (c) => {
  try {
    const body = await c.req.json<{ messageId: string; stepOrder: number }>();
    if (!body.messageId || body.stepOrder === undefined) {
      return c.json({ success: false, error: 'messageId and stepOrder are required' }, 400);
    }
    await addMessageToTemplate(c.env.DB, c.req.param('id'), body.messageId, body.stepOrder);
    return c.json({ success: true, data: null }, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('max')) return c.json({ success: false, error: msg }, 400);
    if (msg.includes('UNIQUE')) return c.json({ success: false, error: 'そのstep_orderは既に使用されています' }, 409);
    console.error('POST /api/templates/:id/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.delete('/api/templates/:id/messages/:messageId', async (c) => {
  try {
    await removeMessageFromTemplate(c.env.DB, c.req.param('id'), c.req.param('messageId'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/templates/:id/messages/:messageId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { templates };
