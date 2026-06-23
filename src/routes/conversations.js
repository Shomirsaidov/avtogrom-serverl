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

const groupCreateSchema = z.object({
  group_name: z.string().min(1, 'Укажите название группы').max(100),
  user_ids: z.array(z.string().uuid('Некорректный ID пользователя')),
});

// ── helpers ───────────────────────────────────────────────────────────────────

// Fetch a single conversation row joined with its specialist and client — used in responses.
async function fetchConversationWithSpecialist(id) {
  const { data, error } = await supabase
    .from('conversations')
    .select(`
      id, user_id, specialist_id, is_group, group_name, created_by,
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
        id, user_id, specialist_id, is_group, group_name, created_by,
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
        const { data: memberGroups } = await supabase
          .from('group_members')
          .select('conversation_id')
          .eq('user_id', req.user.sub);
        
        const groupIds = (memberGroups || []).map(g => g.conversation_id);

        if (groupIds.length > 0) {
          query = query.or(`specialist_id.eq.${specialist.id},id.in.(${groupIds.map(id => `"${id}"`).join(',')})`);
        } else {
          query = query.eq('specialist_id', specialist.id);
        }
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
      .select('id, user_id, specialist_id, is_group, group_name')
      .eq('id', id)
      .maybeSingle();

    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Беседа не найдена' });

    let hasAccessToConv = false;
    if (['admin', 'moderator', 'system_admin'].includes(req.user.role)) {
      hasAccessToConv = true;
    } else if (conv.is_group) {
      const { data: membership } = await supabase
        .from('group_members')
        .select('id')
        .eq('conversation_id', id)
        .eq('user_id', req.user.sub)
        .maybeSingle();
      hasAccessToConv = !!membership;
    } else {
      const specialistIdForMaster = req.user.role === 'master'
        ? await getSpecialistIdForMaster(req.user.sub)
        : null;
      hasAccessToConv = hasAccess(conv, req.user.sub, req.user.role, specialistIdForMaster);
    }

    if (!hasAccessToConv) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    let query = supabase
      .from('messages')
      .select(`
        id, conversation_id, sender_role, body, photo_url, file_url, file_name, created_at, sender_id,
        sender:users(id, name)
      `)
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
      .select('id, user_id, specialist_id, is_group, group_name')
      .eq('id', id)
      .maybeSingle();

    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Беседа не найдена' });

    let hasAccessToConv = false;
    if (['admin', 'moderator', 'system_admin'].includes(req.user.role)) {
      hasAccessToConv = true;
    } else if (conv.is_group) {
      const { data: membership } = await supabase
        .from('group_members')
        .select('id')
        .eq('conversation_id', id)
        .eq('user_id', req.user.sub)
        .maybeSingle();
      hasAccessToConv = !!membership;
    } else {
      const specialistIdForMaster = req.user.role === 'master'
        ? await getSpecialistIdForMaster(req.user.sub)
        : null;
      hasAccessToConv = hasAccess(conv, req.user.sub, req.user.role, specialistIdForMaster);
    }

    if (!hasAccessToConv) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

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
        sender_id: req.user.sub,
      })
      .select(`
        id, conversation_id, sender_role, body, photo_url, file_url, file_name, created_at, sender_id,
        sender:users(id, name)
      `)
      .single();

    if (msgErr) throw msgErr;

    // Trigger notification in background
    (async () => {
      try {
        if (conv.is_group) {
          const { data: members } = await supabase
            .from('group_members')
            .select('user_id')
            .eq('conversation_id', id)
            .neq('user_id', req.user.sub);

          if (members && members.length > 0) {
            let senderName = 'Сотрудник';
            const { data: senderUser } = await supabase
              .from('users')
              .select('name')
              .eq('id', req.user.sub)
              .maybeSingle();
            if (senderUser && senderUser.name) {
              senderName = senderUser.name;
            }

            for (const member of members) {
              await sendNotification({
                userId: member.user_id,
                type: 'chat_message',
                title: conv.group_name || 'Групповой чат',
                body: `${senderName}: ${msgBody}`,
                relatedId: conv.id
              });
            }
          }
        } else {
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

// POST /api/conversations/group — create group chat (admin/moderator only)
router.post('/group', requireAuth, async (req, res, next) => {
  try {
    const isStaff = ['admin', 'moderator', 'system_admin'].includes(req.user.role);
    if (!isStaff) {
      return res.status(403).json({ error: 'Нет прав для создания группы' });
    }

    const parsed = groupCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const { group_name, user_ids } = parsed.data;

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .insert({
        is_group: true,
        group_name: group_name,
        created_by: req.user.sub,
      })
      .select()
      .single();

    if (convErr) throw convErr;

    const membersToInsert = [req.user.sub, ...user_ids].map(uid => ({
      conversation_id: conv.id,
      user_id: uid
    }));

    const uniqueMembers = Array.from(new Set(membersToInsert.map(m => m.user_id))).map(uid => ({
      conversation_id: conv.id,
      user_id: uid
    }));

    const { error: memErr } = await supabase
      .from('group_members')
      .insert(uniqueMembers);

    if (memErr) throw memErr;

    const fullConv = await fetchConversationWithSpecialist(conv.id);
    res.status(201).json({ conversation: fullConv });
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id/members — get members of a group
router.get('/:id/members', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, is_group')
      .eq('id', id)
      .maybeSingle();

    if (!conv) return res.status(404).json({ error: 'Беседа не найдена' });
    if (!conv.is_group) return res.status(400).json({ error: 'Это не групповой чат' });

    let hasAccessToConv = false;
    if (['admin', 'moderator', 'system_admin'].includes(req.user.role)) {
      hasAccessToConv = true;
    } else {
      const { data: membership } = await supabase
        .from('group_members')
        .select('id')
        .eq('conversation_id', id)
        .eq('user_id', req.user.sub)
        .maybeSingle();
      hasAccessToConv = !!membership;
    }

    if (!hasAccessToConv) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const { data: members, error } = await supabase
      .from('group_members')
      .select(`
        id,
        user_id,
        user:users(id, name, role)
      `)
      .eq('conversation_id', id);

    if (error) throw error;
    res.json({ members: members || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations/:id/members — add member to group (admin/moderator only)
router.post('/:id/members', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const isStaff = ['admin', 'moderator', 'system_admin'].includes(req.user.role);
    if (!isStaff) {
      return res.status(403).json({ error: 'Нет прав для добавления участников' });
    }

    const memberSchema = z.object({
      user_id: z.string().uuid(),
    });

    const parsed = memberSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const { user_id } = parsed.data;

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, is_group')
      .eq('id', id)
      .maybeSingle();

    if (!conv) return res.status(404).json({ error: 'Беседа не найдена' });
    if (!conv.is_group) return res.status(400).json({ error: 'Это не групповой чат' });

    const { error } = await supabase
      .from('group_members')
      .insert({
        conversation_id: id,
        user_id: user_id,
      });

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'Пользователь уже состоит в группе' });
      }
      throw error;
    }

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/conversations/:id/members/:userId — remove member from group (admin/moderator only)
router.delete('/:id/members/:userId', requireAuth, async (req, res, next) => {
  try {
    const { id, userId } = req.params;
    const isStaff = ['admin', 'moderator', 'system_admin'].includes(req.user.role);
    if (!isStaff) {
      return res.status(403).json({ error: 'Нет прав для удаления участников' });
    }

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, is_group')
      .eq('id', id)
      .maybeSingle();

    if (!conv) return res.status(404).json({ error: 'Беседа не найдена' });
    if (!conv.is_group) return res.status(400).json({ error: 'Это не групповой чат' });

    const { error } = await supabase
      .from('group_members')
      .delete()
      .eq('conversation_id', id)
      .eq('user_id', userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
