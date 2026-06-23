import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireAuth } from '../auth/middleware.js';

const router = Router();

const tokenSchema = z.object({
  token: z.string().min(1, 'Токен не может быть пустым'),
  platform: z.enum(['ios', 'android', 'web']),
});

// GET /api/notifications - Get historical notifications for current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const { data, error } = await supabase
      .from('notifications')
      .select('id, title, body, type, related_id, is_read, created_at')
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ notifications: data || [] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read - Mark single notification as read
router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', req.user.sub)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Уведомление не найдено' });

    res.json({ notification: data });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/read-all - Mark all notifications as read
router.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.sub)
      .eq('is_read', false);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/tokens - Register device FCM token
router.post('/tokens', requireAuth, async (req, res, next) => {
  try {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { token, platform } = parsed.data;

    const { data, error } = await supabase
      .from('user_notification_tokens')
      .upsert(
        {
          user_id: req.user.sub,
          token,
          platform,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'token' }
      )
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ token: data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/tokens/:token - Unregister/delete push token on logout
router.delete('/tokens/:token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.params;

    const { error } = await supabase
      .from('user_notification_tokens')
      .delete()
      .eq('token', token)
      .eq('user_id', req.user.sub);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
