import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { isSlotStillFree } from '../services/slots.js';
import { requireAuth, optionalAuth } from '../auth/middleware.js';

const router = Router();

const createBookingSchema = z.object({
  service_id: z.string().uuid(),
  specialist_id: z.string().uuid(),
  scheduled_at: z.string().datetime(),
  customer_name: z.string().min(1).max(100),
  customer_phone: z.string().min(5).max(30),
});

// GET /api/bookings/mine — authenticated user's bookings
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id, scheduled_at, duration_minutes, status, customer_name, customer_phone,
        service:services(id, title, price_from, price_fixed, duration_minutes),
        specialist:specialists(id, full_name, photo_url)
      `)
      .eq('user_id', req.user.sub)
      .order('scheduled_at', { ascending: false });

    if (error) throw error;
    res.json({ bookings: data });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings?phone=:phone — guest lookup (kept for migration period)
router.get('/', async (req, res, next) => {
  try {
    const phone = (req.query.phone ?? '').trim();
    if (!phone) return res.status(400).json({ error: 'Укажите номер телефона' });

    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id, scheduled_at, duration_minutes, status, customer_name, customer_phone,
        service:services(id, title, price_from, price_fixed, duration_minutes),
        specialist:specialists(id, full_name, photo_url)
      `)
      .eq('customer_phone', phone)
      .order('scheduled_at', { ascending: false });

    if (error) throw error;
    res.json({ bookings: data });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings
router.post('/', optionalAuth, async (req, res, next) => {
  try {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const body = parsed.data;

    const { data: service, error: serviceErr } = await supabase
      .from('services')
      .select('id,duration_minutes')
      .eq('id', body.service_id)
      .maybeSingle();
    if (serviceErr) throw serviceErr;
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const { data: link, error: linkErr } = await supabase
      .from('service_specialists')
      .select('service_id')
      .eq('service_id', body.service_id)
      .eq('specialist_id', body.specialist_id)
      .maybeSingle();
    if (linkErr) throw linkErr;
    if (!link) return res.status(400).json({ error: 'Specialist does not offer this service' });

    const free = await isSlotStillFree({
      specialistId: body.specialist_id,
      scheduledAt: body.scheduled_at,
      durationMinutes: service.duration_minutes,
    });
    if (!free) return res.status(409).json({ error: 'Slot is no longer available' });

    const { data: booking, error: insertErr } = await supabase
      .from('bookings')
      .insert({
        service_id: body.service_id,
        specialist_id: body.specialist_id,
        scheduled_at: body.scheduled_at,
        duration_minutes: service.duration_minutes,
        customer_name: body.customer_name,
        customer_phone: body.customer_phone,
        user_id: req.user?.sub ?? null,
      })
      .select('id,service_id,specialist_id,scheduled_at,duration_minutes,status,created_at')
      .single();
    if (insertErr) throw insertErr;

    res.status(201).json({ booking });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bookings/:id/cancel
router.patch('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: booking, error: fetchErr } = await supabase
      .from('bookings')
      .select('id, status, user_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!booking) return res.status(404).json({ error: 'Запись не найдена' });
    if (booking.user_id !== req.user.sub) {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return res.status(409).json({ error: 'Запись нельзя отменить' });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) throw updateErr;
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
