import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireAuth } from '../auth/middleware.js';

const router = Router();

const sendSchema = z.object({
  body: z.string().min(1).max(2000),
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateConversation(userId) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) return existing;

  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: userId })
    .select()
    .single();

  if (error) throw error;
  return data;
}

function hasAccess(conv, userId, userRole) {
  if (conv.user_id === userId) return true;
  return ['admin', 'moderator', 'system_admin', 'master'].includes(userRole);
}

// ── routes ────────────────────────────────────────────────────────────────────

// GET /api/conversations
// Client → their single conversation row.
// Staff (future business app) → all conversations.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const isStaff = ['admin', 'moderator', 'system_admin', 'master'].includes(req.user.role);

    let query = supabase
      .from('conversations')
      .select('id, user_id, last_message_at, last_message_body, last_message_sender, created_at')
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (!isStaff) query = query.eq('user_id', req.user.sub);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ conversations: data || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations — idempotent create-or-get
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const conv = await getOrCreateConversation(req.user.sub);
    res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id/messages?after=<ISO>&limit=<n>
// Incremental polling: only rows with created_at > after are returned.
router.get('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const after = req.query.after;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, user_id')
      .eq('id', id)
      .maybeSingle();

    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Беседа не найдена' });
    if (!hasAccess(conv, req.user.sub, req.user.role)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    let query = supabase
      .from('messages')
      .select('id, conversation_id, sender_role, body, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (after) query = query.gt('created_at', after);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ messages: data || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations/:id/messages
router.post('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Текст сообщения не может быть пустым' });
    }

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, user_id')
      .eq('id', id)
      .maybeSingle();

    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Беседа не найдена' });
    if (!hasAccess(conv, req.user.sub, req.user.role)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const isStaff = ['admin', 'moderator', 'system_admin', 'master'].includes(req.user.role);
    const senderRole = isStaff ? 'business' : 'client';

    const { data: msg, error: msgErr } = await supabase
      .from('messages')
      .insert({ conversation_id: id, sender_role: senderRole, body: parsed.data.body })
      .select('id, conversation_id, sender_role, body, created_at')
      .single();

    if (msgErr) throw msgErr;

    // Denormalise preview columns so the list query stays a single-table read
    await supabase
      .from('conversations')
      .update({
        last_message_at: msg.created_at,
        last_message_body: parsed.data.body,
        last_message_sender: senderRole,
      })
      .eq('id', id);

    res.status(201).json({ message: msg });
  } catch (err) {
    next(err);
  }
});

export default router;
