import { Hono } from 'hono';
import {
  getMessages,
  getMessageById,
  createMessage,
  updateMessage,
  deleteMessage,
} from '@line-crm/db';
import type { Env } from '../index.js';

const messages = new Hono<Env>();

messages.get('/api/messages', async (c) => {
  try {
    const type = c.req.query('type') ?? undefined;
    const tag = c.req.query('tag') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '200');
    const items = await getMessages(c.env.DB, { type, tag, limit });
    return c.json({
      success: true,
      data: items.map((m) => ({
        id: m.id,
        messageType: m.message_type,
        content: m.content,
        altText: m.alt_text,
        tags: JSON.parse(m.tags) as string[],
        label: m.label,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

messages.get('/api/messages/:id', async (c) => {
  try {
    const item = await getMessageById(c.env.DB, c.req.param('id'));
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: item.id,
        messageType: item.message_type,
        content: item.content,
        altText: item.alt_text,
        tags: JSON.parse(item.tags) as string[],
        label: item.label,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    });
  } catch (err) {
    console.error('GET /api/messages/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

messages.post('/api/messages', async (c) => {
  try {
    const body = await c.req.json<{
      messageType: 'text' | 'image' | 'flex' | 'video';
      content: string;
      altText?: string | null;
      tags?: string[];
      label?: string | null;
    }>();
    if (!body.messageType || !body.content) {
      return c.json({ success: false, error: 'messageType and content are required' }, 400);
    }
    const item = await createMessage(c.env.DB, body);
    return c.json({
      success: true,
      data: {
        id: item.id,
        messageType: item.message_type,
        content: item.content,
        altText: item.alt_text,
        tags: JSON.parse(item.tags) as string[],
        label: item.label,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

messages.put('/api/messages/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Partial<{ messageType: string; content: string; altText: string | null; tags: string[]; label: string | null }>>();
    await updateMessage(c.env.DB, id, body);
    const updated = await getMessageById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: updated.id,
        messageType: updated.message_type,
        content: updated.content,
        altText: updated.alt_text,
        tags: JSON.parse(updated.tags) as string[],
        label: updated.label,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err) {
    console.error('PUT /api/messages/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

messages.delete('/api/messages/:id', async (c) => {
  try {
    await deleteMessage(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('FOREIGN KEY') || msg.includes('RESTRICT')) {
      return c.json({ success: false, error: 'このメッセージはテンプレートで使用中のため削除できません' }, 409);
    }
    console.error('DELETE /api/messages/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { messages as messagesRoute };
