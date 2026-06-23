import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireAuth } from '../auth/middleware.js';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { sendNotification } from '../services/notifications.js';

const router = Router();

const sendSchema = z.object({
  body: z.string().min(1).max(2000).optional(),
  photo_base64: z.string().optional(),
  file_base64: z.string().optional(),
  file_name: z.string().max(255).optional(),
  sender_role: z.enum(['client', 'business']).optional(),
}).refine(
  data => data.body || data.photo_base64 || data.file_base64,
  { message: 'Укажите текст сообщения или прикрепите файл' },
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

async function getSpecialistIdForMaster(userId) {
  const { data } = await supabase
    .from('specialists')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.id || null;
}

function hasAccess(conv, userId, userRole, specialistIdForMaster) {
  if (conv.user_id === userId) return true;
  if (userRole === 'master') {
    return specialistIdForMaster !== null && conv.specialist_id === specialistIdForMaster;
  }
  return ['admin', 'moderator', 'system_admin'].includes(userRole);
}

// ── routes ────────────────────────────────────────────────────────────────────

// GET /api/conversations
// Client → their conversations (one per specialist they've chatted with).
// Staff → all conversations (for future business app).
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const isStaff = ['admin', 'moderator', 'system_admin', 'master'].includes(req.user.role);
    const isMaster = req.user.role === 'master';

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

    if (isMaster) {
      const { data: specialist } = await supabase
        .from('specialists')
        .select('id')
        .eq('user_id', req.user.sub)
        .maybeSingle();

      if (specialist) {
        query = query.eq('specialist_id', specialist.id);
      } else {
        return res.json({ conversations: [] });
      }
    } else if (!isStaff) {
      query = query.eq('user_id', req.user.sub);
    }

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
      .select('id, user_id, specialist_id')
      .eq('id', id)
      .maybeSingle();

    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Беседа не найдена' });

    const specialistIdForMaster = req.user.role === 'master'
      ? await getSpecialistIdForMaster(req.user.sub)
      : null;
    if (!hasAccess(conv, req.user.sub, req.user.role, specialistIdForMaster)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    let query = supabase
      .from('messages')
      .select('id, conversation_id, sender_role, body, photo_url, file_url, file_name, created_at')
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
      .select('id, user_id, specialist_id')
      .eq('id', id)
      .maybeSingle();

    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Беседа не найдена' });

    const specialistIdForMaster = req.user.role === 'master'
      ? await getSpecialistIdForMaster(req.user.sub)
      : null;
    if (!hasAccess(conv, req.user.sub, req.user.role, specialistIdForMaster)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    // sender_role logic (permanent — do not change without understanding all 3 cases):
    // 1. regular client in mobile app → never sends sender_role → ownership check gives 'client'
    // 2. staff (admin) in mobile app → never sends sender_role → ownership check gives 'client'
    // 3. staff in admin-chat.html → sends sender_role:'business' → override to 'business'
    const isStaff = ['admin', 'moderator', 'system_admin', 'master'].includes(req.user.role);
    const isConvOwner = conv.user_id === req.user.sub;
    let senderRole = isConvOwner ? 'client' : 'business';
    if (parsed.data.sender_role === 'business' && isStaff) {
      senderRole = 'business';
    }

    let photoUrl = null;
    let fileUrl = null;
    let fileName = null;

    if (parsed.data.file_base64) {
      const fname = parsed.data.file_name || 'Файл';
      const uploadResult = await uploadToCloudinary(parsed.data.file_base64, {
        folder: 'avtogrom/chat',
        resource_type: 'auto',
      });
      fileUrl = uploadResult.url;
      fileName = fname;
    } else if (parsed.data.photo_base64) {
      const uploadResult = await uploadToCloudinary(parsed.data.photo_base64, {
        folder: 'avtogrom/chat',
      });
      photoUrl = uploadResult.url;
    }

    const msgBody = parsed.data.body || (fileUrl ? `📄 ${fileName}` : photoUrl ? '📷 Фото' : '');

    const { data: msg, error: msgErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: id,
        sender_role: senderRole,
        body: msgBody,
        photo_url: photoUrl,
        file_url: fileUrl,
        file_name: fileName,
      })
      .select('id, conversation_id, sender_role, body, photo_url, file_url, file_name, created_at')
      .single();

    if (msgErr) throw msgErr;

    // Trigger notification in background
    (async () => {
      try {
        if (senderRole === 'client') {
          const { data: spec } = await supabase.from('specialists').select('user_id').eq('id', conv.specialist_id).maybeSingle();
          if (spec && spec.user_id) {
            await sendNotification({
              userId: spec.user_id,
              type: 'chat_message',
              title: 'Новое сообщение от клиента',
              body: msgBody,
              relatedId: conv.id
            });
          }
        } else {
          const { data: spec } = await supabase.from('specialists').select('full_name').eq('id', conv.specialist_id).maybeSingle();
          const specName = spec?.full_name || 'Автосервис';
          await sendNotification({
            userId: conv.user_id,
            type: 'chat_message',
            title: specName,
            body: msgBody,
            relatedId: conv.id
          });
        }
      } catch (err) {
        console.error('[Notification Hook Error in Chat]', err);
      }
    })();

    const preview = fileUrl ? '📄 ' + fileName : photoUrl ? '📷 Фото' : msgBody;

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
