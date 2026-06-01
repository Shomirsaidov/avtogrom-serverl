import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireAuth } from '../auth/middleware.js';
import { uploadToCloudinary } from '../utils/cloudinary.js';

const router = Router();

const sendSchema = z.object({
  body: z.string().min(1).max(2000).optional(),
  photo_base64: z.string().optional(),
  sender_role: z.enum(['client', 'business']).optional(),
}).refine(
  data => data.body || data.photo_base64,
  { message: 'Укажите текст сообщения или прикрепите фото' },
);

const createSchema = z.object({
  specialist_id: z.string().uuid('Укажите корректный идентификатор специалиста'),
});

// ── helpers ───────────────────────────────────────────────────────────────────

// Fetch a single conversation row joined with its specialist and client — used in responses.
async function fetchConversationWithSpecialist(id) {
  const { data, error } = await supabase
    .from('conversations')
    .select(`
      id, user_id, specialist_id,
      last_message_at, last_message_body, last_message_sender,
      created_at,
      specialist:specialists(id, full_name, photo_url),
      client:users(id, name)
    `)
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function getOrCreateConversation(userId, specialistId) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('specialist_id', specialistId)
    .maybeSingle();

  if (existing) return fetchConversationWithSpecialist(existing.id);

  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: userId, specialist_id: specialistId })
    .select('id')
    .single();

  if (error) throw error;
  return fetchConversationWithSpecialist(data.id);
}

function hasAccess(conv, userId, userRole) {
  if (conv.user_id === userId) return true;
  return ['admin', 'moderator', 'system_admin', 'master'].includes(userRole);
}

// ── routes ────────────────────────────────────────────────────────────────────

// GET /api/conversations
// Client → their conversations (one per specialist they've chatted with).
// Staff → all conversations (for future business app).
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const isStaff = ['admin', 'moderator', 'system_admin', 'master'].includes(req.user.role);

    let query = supabase
      .from('conversations')
      .select(`
        id, user_id, specialist_id,
        last_message_at, last_message_body, last_message_sender,
        created_at,
        specialist:specialists(id, full_name, photo_url),
        client:users(id, name)
      `)
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (!isStaff) query = query.eq('user_id', req.user.sub);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ conversations: data || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations — idempotent: creates or returns existing thread for (user, specialist)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const conv = await getOrCreateConversation(req.user.sub, parsed.data.specialist_id);
    res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id/messages?after=<ISO>&limit=<n>
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
      .select('id, conversation_id, sender_role, body, photo_url, created_at')
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
      return res.status(400).json({ error: parsed.error.issues[0].message || 'Некорректное сообщение' });
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
    let senderRole = conv.user_id === req.user.sub ? 'client' : 'business';
    if (isStaff && parsed.data.sender_role) senderRole = parsed.data.sender_role;

    let photoUrl = null;
    if (parsed.data.photo_base64) {
      const uploadResult = await uploadToCloudinary(parsed.data.photo_base64, {
        folder: 'avtogrom/chat',
      });
      photoUrl = uploadResult.url;
    }

    const msgBody = parsed.data.body || (photoUrl ? 'Фото' : '');

    const { data: msg, error: msgErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: id,
        sender_role: senderRole,
        body: msgBody,
        photo_url: photoUrl,
      })
      .select('id, conversation_id, sender_role, body, photo_url, created_at')
      .single();

    if (msgErr) throw msgErr;

    const preview = photoUrl ? '📷 Фото' : msgBody;

    await supabase
      .from('conversations')
      .update({
        last_message_at: msg.created_at,
        last_message_body: preview,
        last_message_sender: senderRole,
      })
      .eq('id', id);

    res.status(201).json({ message: msg });
  } catch (err) {
    next(err);
  }
});

export default router;
