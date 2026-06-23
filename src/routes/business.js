import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireAuth } from '../auth/middleware.js';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { sendNotification } from '../services/notifications.js';
import { handleFirstVisit } from '../services/referrals.js';


const router = Router();

// All business routes require auth
router.use(requireAuth);

function isAdminOrModerator(req) {
  return req.user.role === 'admin' || req.user.role === 'moderator';
}

function isAdmin(req) {
  return req.user.role === 'admin';
}

// GET /api/business/bookings — list bookings with filters
router.get('/bookings', async (req, res, next) => {
  try {
    const { date, specialist_id, status, search } = req.query;
    const isMaster = req.user.role === 'master';

    let query = supabase
      .from('bookings')
      .select(`
        id, scheduled_at, duration_minutes, status, customer_name, customer_phone, created_at,
        service:services(id, title, price_from, price_fixed, duration_minutes),
        specialist:specialists(id, full_name, photo_url, specialization),
        car:cars(id, make, model, year, license_plate)
      `)
      .order('scheduled_at', { ascending: false });

    // Masters can only see their own bookings
    if (isMaster) {
      const { data: specialist } = await supabase
        .from('specialists')
        .select('id')
        .eq('user_id', req.user.sub)
        .maybeSingle();

      if (specialist) {
        query = query.eq('specialist_id', specialist.id);
      } else {
        return res.json({ bookings: [] });
      }
    }

    // Filters
    if (date) {
      const dayStart = `${date}T00:00:00.000Z`;
      const dayEnd = `${date}T23:59:59.999Z`;
      query = query.gte('scheduled_at', dayStart).lte('scheduled_at', dayEnd);
    }

    if (specialist_id) {
      query = query.eq('specialist_id', specialist_id);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (search) {
      query = query.or(
        `customer_name.ilike.%${search}%,customer_phone.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    const bookings = (data || []).map((b) => ({
      id: b.id,
      scheduled_at: b.scheduled_at,
      duration_minutes: b.duration_minutes,
      status: b.status,
      customer_name: b.customer_name,
      customer_phone: b.customer_phone,
      created_at: b.created_at,
      service_id: b.service?.id,
      service_name: b.service?.title,
      service_price: b.service?.price_from,
      specialist_id: b.specialist?.id,
      specialist_name: b.specialist?.full_name,
      specialist_photo: b.specialist?.photo_url,
      car: b.car
        ? `${b.car.make} ${b.car.model} (${b.car.license_plate})`
        : null,
    }));

    res.json({ bookings });
  } catch (err) {
    next(err);
  }
});

// GET /api/business/bookings/:id — single booking detail
router.get('/bookings/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const isMaster = req.user.role === 'master';

    let query = supabase
      .from('bookings')
      .select(`
        id, scheduled_at, duration_minutes, status, customer_name, customer_phone, created_at,
        service:services(id, title, description, price_from, price_fixed, duration_minutes),
        specialist:specialists(id, full_name, photo_url, specialization),
        car:cars(id, make, model, year, license_plate)
      `)
      .eq('id', id);

    if (isMaster) {
      const { data: specialist } = await supabase
        .from('specialists')
        .select('id')
        .eq('user_id', req.user.sub)
        .maybeSingle();

      if (specialist) {
        query = query.eq('specialist_id', specialist.id);
      } else {
        return res.status(404).json({ error: 'Запись не найдена' });
      }
    }

    const { data: booking, error } = await query.maybeSingle();
    if (error) throw error;
    if (!booking) return res.status(404).json({ error: 'Запись не найдена' });

    res.json({
      booking: {
        id: booking.id,
        scheduled_at: booking.scheduled_at,
        duration_minutes: booking.duration_minutes,
        status: booking.status,
        customer_name: booking.customer_name,
        customer_phone: booking.customer_phone,
        created_at: booking.created_at,
        service: booking.service,
        specialist: booking.specialist,
        car: booking.car,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/business/bookings/:id/status — change booking status
const statusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'cancelled', 'in_progress', 'completed']),
});

router.patch('/bookings/:id/status', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Некорректный статус' });
    }

    const { id } = req.params;
    const newStatus = parsed.data.status;

    const { data: booking, error: fetchErr } = await supabase
      .from('bookings')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!booking) return res.status(404).json({ error: 'Запись не найдена' });

    // Validate status transitions
    const allowedTransitions = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['cancelled', 'in_progress'],
      in_progress: ['completed'],
    };

    const allowed = allowedTransitions[booking.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return res.status(409).json({
        error: `Нельзя перевести запись из статуса "${booking.status}" в "${newStatus}"`,
      });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('bookings')
      .update({ status: newStatus })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    // Trigger notification to client in background
    (async () => {
      try {
        if (updated.user_id) {
          let title = '';
          let body = '';

          switch (newStatus) {
            case 'confirmed':
              title = 'Запись подтверждена';
              body = 'Ваша запись подтверждена. Ждём вас!';
              break;
            case 'cancelled':
              title = 'Запись отменена';
              body = 'Запись отменена автосервисом.';
              break;
            case 'in_progress':
              title = 'Начало обслуживания';
              body = 'Ваш автомобиль принят в работу.';
              break;
            case 'completed':
              title = 'Обслуживание завершено';
              body = 'Работы завершены. Спасибо за визит!';
              break;
          }

          if (title && body) {
            await sendNotification({
              userId: updated.user_id,
              type: `booking_${newStatus}`,
              title,
              body,
              relatedId: updated.id
            });
          }

          // If booking is completed, check for referral first-visit reward
          if (newStatus === 'completed') {
            const { count } = await supabase
              .from('bookings')
              .select('id', { count: 'exact', head: true })
              .eq('user_id', updated.user_id)
              .eq('status', 'completed');

            if (count === 1) {
              await handleFirstVisit(updated.user_id);
            }
          }
        }
      } catch (err) {
        console.error('[Notification Hook Error in Business Status]', err);
      }
    })();

    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
});

// GET /api/business/specialists — list all specialists
router.get('/specialists', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('specialists')
      .select('id, full_name, photo_url, specialization, user_id')
      .order('full_name', { ascending: true });

    if (error) throw error;
    res.json({ specialists: data || [] });
  } catch (err) {
    next(err);
  }
});

// GET /api/business/services — list services, optionally filtered by specialist_id
router.get('/services', async (req, res, next) => {
  try {
    const { specialist_id } = req.query;

    let query = supabase
      .from('services')
      .select('id, title, description, price_from, price_fixed, duration_minutes, photo_url')
      .order('title', { ascending: true });

    if (specialist_id) {
      const { data: links } = await supabase
        .from('service_specialists')
        .select('service_id')
        .eq('specialist_id', specialist_id);

      const serviceIds = (links || []).map((l) => l.service_id);
      if (serviceIds.length > 0) {
        query = query.in('id', serviceIds);
      } else {
        return res.json({ services: [] });
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ services: data || [] });
  } catch (err) {
    next(err);
  }
});

// GET /api/business/clients — list clients with visit stats
router.get('/clients', async (req, res, next) => {
  try {
    const { search } = req.query;
    const isMaster = req.user.role === 'master';

    let query = supabase
      .from('bookings')
      .select('customer_name, customer_phone, scheduled_at, status')
      .order('scheduled_at', { ascending: false });

    if (isMaster) {
      const { data: specialist } = await supabase
        .from('specialists')
        .select('id')
        .eq('user_id', req.user.sub)
        .maybeSingle();

      if (specialist) {
        query = query.eq('specialist_id', specialist.id);
      } else {
        return res.json({ clients: [] });
      }
    }

    if (search) {
      query = query.or(
        `customer_name.ilike.%${search}%,customer_phone.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    // Aggregate by phone
    const clientMap = new Map();
    for (const b of data || []) {
      if (!b.customer_phone) continue;
      if (!clientMap.has(b.customer_phone)) {
        clientMap.set(b.customer_phone, {
          name: b.customer_name,
          phone: b.customer_phone,
          visit_count: 0,
          last_visit: null,
        });
      }
      const client = clientMap.get(b.customer_phone);
      client.visit_count++;
      if (!client.last_visit || b.scheduled_at > client.last_visit) {
        client.last_visit = b.scheduled_at;
      }
    }

    const clients = Array.from(clientMap.values()).sort(
      (a, b) => b.visit_count - a.visit_count
    );

    res.json({ clients });
  } catch (err) {
    next(err);
  }
});

// POST /api/business/clients/start-conversation — find or create conversation with client by phone
router.post('/clients/start-conversation', async (req, res, next) => {
  try {
    const { phone, name } = req.body || {};
    if (!phone) {
      return res.status(400).json({ error: 'Укажите номер телефона' });
    }

    // 1. Try to find a user_id from bookings with this phone
    const { data: bookings } = await supabase
      .from('bookings')
      .select('user_id, specialist_id')
      .eq('customer_phone', phone)
      .order('created_at', { ascending: false })
      .limit(1);

    let userId = bookings?.[0]?.user_id;
    const specialistId = bookings?.[0]?.specialist_id;

    // 2. If no user_id, create a placeholder user for the client
    if (!userId) {
      const placeholderEmail = `client_${phone.replace(/[^0-9]/g, '')}@placeholder.mservice`;
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', placeholderEmail)
        .maybeSingle();

      if (existingUser) {
        userId = existingUser.id;
      } else {
        const { data: newUser, error: userErr } = await supabase
          .from('users')
          .insert({
            name: name || 'Клиент',
            email: placeholderEmail,
            password_hash: 'placeholder_no_auth',
            role: 'client',
          })
          .select('id')
          .single();

        if (userErr) throw userErr;
        userId = newUser.id;
      }
    }

    // 3. Find a specialist — use the booking's specialist or fallback to any
    let targetSpecialistId = specialistId;
    if (!targetSpecialistId) {
      const { data: anySpecialist } = await supabase
        .from('specialists')
        .select('id')
        .limit(1)
        .maybeSingle();
      targetSpecialistId = anySpecialist?.id;
    }

    if (!targetSpecialistId) {
      return res.status(400).json({ error: 'Нет сотрудников в системе' });
    }

    // 4. Get or create conversation
    const { data: existingConv } = await supabase
      .from('conversations')
      .select('id, user_id, specialist_id, last_message_at, last_message_body, last_message_sender, created_at, specialist:specialists(id, full_name, photo_url), client:users(id, name)')
      .eq('user_id', userId)
      .eq('specialist_id', targetSpecialistId)
      .maybeSingle();

    if (existingConv) {
      return res.json({ conversation: existingConv });
    }

    const { data: newConv, error: convErr } = await supabase
      .from('conversations')
      .insert({ user_id: userId, specialist_id: targetSpecialistId })
      .select('id, user_id, specialist_id, last_message_at, last_message_body, last_message_sender, created_at, specialist:specialists(id, full_name, photo_url), client:users(id, name)')
      .single();

    if (convErr) throw convErr;
    res.json({ conversation: newConv });
  } catch (err) {
    next(err);
  }
});

// GET /api/business/clients/conversation — find conversation by client phone
router.get('/clients/conversation', async (req, res, next) => {
  try {
    const { phone } = req.query;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Укажите номер телефона' });
    }

    // Find bookings with this phone that have a user_id
    const { data: bookings } = await supabase
      .from('bookings')
      .select('user_id')
      .eq('customer_phone', phone)
      .not('user_id', 'is', null)
      .limit(1);

    const userId = bookings?.[0]?.user_id;
    if (!userId) {
      return res.json({ conversation: null });
    }

    const { data } = await supabase
      .from('conversations')
      .select(`
        id, user_id, specialist_id,
        last_message_at, last_message_body, last_message_sender,
        created_at,
        specialist:specialists(id, full_name, photo_url),
        client:users(id, name)
      `)
      .eq('user_id', userId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    res.json({ conversation: data || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/business/clients/history — booking history by phone
router.get('/clients/history', async (req, res, next) => {
  try {
    const { phone } = req.query;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Укажите номер телефона' });
    }

    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id, scheduled_at, duration_minutes, status, customer_name, customer_phone,
        service:services(id, title, price_from, price_fixed),
        specialist:specialists(id, full_name, photo_url)
      `)
      .eq('customer_phone', phone)
      .order('scheduled_at', { ascending: false });

    if (error) throw error;

    const history = (data || []).map((b) => ({
      id: b.id,
      scheduled_at: b.scheduled_at,
      duration_minutes: b.duration_minutes,
      status: b.status,
      service_name: b.service?.title,
      specialist_name: b.specialist?.full_name,
      customer_name: b.customer_name,
    }));

    res.json({ history });
  } catch (err) {
    next(err);
  }
});

// ─── Schedule routes ────────────────────────────────────────────

// GET /api/business/schedules — get schedules (optionally filtered by specialist_id)
router.get('/schedules', async (req, res, next) => {
  try {
    const { specialist_id } = req.query;
    const isMaster = req.user.role === 'master';

    let query = supabase
      .from('specialist_schedules')
      .select(`
        id, specialist_id, day_of_week, start_time, end_time,
        specialist:specialists(full_name)
      `);

    if (isMaster) {
      const { data: spec } = await supabase
        .from('specialists')
        .select('id')
        .eq('user_id', req.user.sub)
        .maybeSingle();
      if (spec) {
        query = query.eq('specialist_id', spec.id);
      } else {
        return res.json({ schedules: [] });
      }
    }

    if (specialist_id) {
      query = query.eq('specialist_id', specialist_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ schedules: data || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/business/schedules — create or update schedule entries (batch)
const scheduleEntrySchema = z.object({
  entries: z.array(
    z.object({
      specialist_id: z.string().uuid(),
      day_of_week: z.number().int().min(0).max(6),
      start_time: z.string().regex(/^\d{2}:\d{2}$/),
      end_time: z.string().regex(/^\d{2}:\d{2}$/),
    })
  ),
});

router.post('/schedules', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = scheduleEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Некорректные данные графика' });
    }

    const { entries } = parsed.data;
    const results = [];

    for (const entry of entries) {
      // Upsert: if a schedule for this specialist+day exists, update it; else insert
      const { data: existing } = await supabase
        .from('specialist_schedules')
        .select('id')
        .eq('specialist_id', entry.specialist_id)
        .eq('day_of_week', entry.day_of_week)
        .maybeSingle();

      if (existing) {
        const { data, error } = await supabase
          .from('specialist_schedules')
          .update({
            start_time: entry.start_time,
            end_time: entry.end_time,
          })
          .eq('id', existing.id)
          .select()
          .single();
        if (error) throw error;
        results.push(data);
      } else {
        const { data, error } = await supabase
          .from('specialist_schedules')
          .insert({
            specialist_id: entry.specialist_id,
            day_of_week: entry.day_of_week,
            start_time: entry.start_time,
            end_time: entry.end_time,
          })
          .select()
          .single();
        if (error) throw error;
        results.push(data);
      }
    }

    res.json({ schedules: results });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/business/schedules/:id — delete schedule entry
router.delete('/schedules/:id', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const { id } = req.params;
    const { error } = await supabase
      .from('specialist_schedules')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Services CRUD ────────────────────────────────────────────────

const serviceSchema = z.object({
  title: z.string().min(1, 'Название обязательно'),
  description: z.string().optional(),
  price_from: z.number().min(0),
  price_fixed: z.boolean(),
  duration_minutes: z.number().int().min(1),
  photo_url: z.string().optional(),
  discount_tag: z.string().optional().nullable(),
  discount_price: z.number().min(0).optional().nullable(),
});

// POST /api/business/services — create service
router.post('/services', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = serviceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { data, error } = await supabase
      .from('services')
      .insert(parsed.data)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ service: data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/business/services/:id — update service
router.put('/services/:id', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = serviceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { id } = req.params;
    const { data, error } = await supabase
      .from('services')
      .update(parsed.data)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Услуга не найдена' });
    res.json({ service: data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/business/services/:id — delete service
router.delete('/services/:id', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const { id } = req.params;
    const { error } = await supabase
      .from('services')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Specialists (Employees) CRUD ────────────────────────────────

const specialistSchema = z.object({
  full_name: z.string().min(1, 'Имя обязательно'),
  photo_url: z.string().optional(),
  specialization: z.string().optional(),
});

// POST /api/business/specialists — create specialist
router.post('/specialists', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = specialistSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { data, error } = await supabase
      .from('specialists')
      .insert(parsed.data)
      .select()
      .single();

    if (error) throw error;

    // Create default schedule: Mon-Sat 09:00-19:00, Sunday off
    const defaultDays = [1, 2, 3, 4, 5, 6];
    const defaultEntries = defaultDays.map((day) => ({
      specialist_id: data.id,
      day_of_week: day,
      start_time: '09:00',
      end_time: '19:00',
    }));

    const { error: schedErr } = await supabase
      .from('specialist_schedules')
      .insert(defaultEntries);

    if (schedErr) console.error('Failed to create default schedule:', schedErr);

    res.status(201).json({ specialist: data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/business/specialists/:id — update specialist
router.put('/specialists/:id', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = specialistSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { id } = req.params;
    const { data, error } = await supabase
      .from('specialists')
      .update(parsed.data)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Сотрудник не найден' });
    res.json({ specialist: data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/business/specialists/:id — delete specialist
router.delete('/specialists/:id', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const { id } = req.params;
    const { error } = await supabase
      .from('specialists')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/business/specialists/:id/link-user — link a user to a specialist (admin only)
router.patch('/specialists/:id/link-user', async (req, res, next) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = z.object({ user_id: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Укажите корректный user_id' });
    }

    const { user_id } = parsed.data;

    // Unlink any previous specialist from this user
    await supabase.from('specialists').update({ user_id: null }).eq('user_id', user_id);

    // Link this specialist to the user
    const { data, error } = await supabase
      .from('specialists')
      .update({ user_id })
      .eq('id', req.params.id)
      .select('id, full_name, user_id')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Сотрудник не найден' });

    res.json({ specialist: data });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/business/specialists/:id/unlink-user — unlink user from specialist (admin only)
router.patch('/specialists/:id/unlink-user', async (req, res, next) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const { data, error } = await supabase
      .from('specialists')
      .update({ user_id: null })
      .eq('id', req.params.id)
      .select('id, full_name, user_id')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Сотрудник не найден' });

    res.json({ specialist: data });
  } catch (err) {
    next(err);
  }
});

// ─── Service-Specialist assignment ────────────────────────────────

const serviceLinkSchema = z.object({
  service_id: z.string().uuid(),
  specialist_id: z.string().uuid(),
});

// POST /api/business/service-specialists — link service to specialist
router.post('/service-specialists', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = serviceLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Некорректные данные' });
    }

    const { data, error } = await supabase
      .from('service_specialists')
      .insert(parsed.data)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Связь уже существует' });
      }
      throw error;
    }

    res.status(201).json({ link: data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/business/service-specialists — unlink service from specialist
router.delete('/service-specialists', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const { service_id, specialist_id } = req.query;
    if (!service_id || !specialist_id) {
      return res.status(400).json({ error: 'Укажите service_id и specialist_id' });
    }

    const { error } = await supabase
      .from('service_specialists')
      .delete()
      .eq('service_id', service_id)
      .eq('specialist_id', specialist_id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/business/specialists/:id/services — get services for a specialist
router.get('/specialists/:id/services', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: links, error } = await supabase
      .from('service_specialists')
      .select('service_id, service:services(id, title)')
      .eq('specialist_id', id);

    if (error) throw error;

    const services = (links || []).map((l) => l.service).filter(Boolean);
    res.json({ services });
  } catch (err) {
    next(err);
  }
});

// GET /api/business/services/:id/specialists — get specialists for a service
router.get('/services/:id/specialists', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: links, error } = await supabase
      .from('service_specialists')
      .select('specialist_id, specialist:specialists(id, full_name, photo_url, specialization)')
      .eq('service_id', id);

    if (error) throw error;

    const specialists = (links || []).map((l) => l.specialist).filter(Boolean);
    res.json({ specialists });
  } catch (err) {
    next(err);
  }
});

// POST /api/business/upload — upload image to Cloudinary
const uploadSchema = z.object({
  file_base64: z.string().min(1),
});

router.post('/upload', async (req, res, next) => {
  try {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Файл не передан' });
    }

    const result = await uploadToCloudinary(parsed.data.file_base64, {
      folder: 'avtogrom',
    });

    res.json({ url: result.url, public_id: result.public_id });
  } catch (err) {
    next(err);
  }
});

// ─── User / Role management ────────────────────────────────────────

// GET /api/business/users — list all users with roles
router.get('/users', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ users: data || [] });
  } catch (err) {
    next(err);
  }
});

const roleSchema = z.object({
  role: z.enum(['admin', 'moderator', 'master', 'client']),
});

// PATCH /api/business/users/:id/role — update user role (admin only)
router.patch('/users/:id/role', async (req, res, next) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Некорректная роль' });
    }

    const { id } = req.params;
    const { data, error } = await supabase
      .from('users')
      .update({ role: parsed.data.role })
      .eq('id', id)
      .select('id, name, email, role')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ user: data });
  } catch (err) {
    next(err);
  }
});

// ─── Referrals Admin Settings & History ─────────────────────────
router.get('/referrals/settings', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) return res.status(403).json({ error: 'Нет доступа' });
    const { data, error } = await supabase.from('referral_settings').select('*').maybeSingle();
    if (error) throw error;
    res.json({ settings: data });
  } catch (err) {
    next(err);
  }
});

const referralSettingsSchema = z.object({
  enabled: z.boolean(),
  signup_reward: z.number().int().nonnegative(),
  referrer_signup_reward: z.number().int().nonnegative(),
  referrer_first_visit_reward: z.number().int().nonnegative(),
});

router.put('/referrals/settings', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) return res.status(403).json({ error: 'Нет доступа' });
    const parsed = referralSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { data, error } = await supabase
      .from('referral_settings')
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString()
      })
      .eq('id', '00000000-0000-0000-0000-000000000002')
      .select()
      .single();

    if (error) throw error;
    res.json({ settings: data });
  } catch (err) {
    next(err);
  }
});

router.get('/referrals/history', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) return res.status(403).json({ error: 'Нет доступа' });

    const { data: transactions, error: txErr } = await supabase
      .from('referral_transactions')
      .select(`
        id, amount, type, created_at,
        user:users!user_id (id, name),
        referee:users!referee_id (id, name)
      `)
      .order('created_at', { ascending: false });

    if (txErr) throw txErr;

    const { count: totalReferrals } = await supabase
      .from('referrals')
      .select('id', { count: 'exact', head: true });

    const { count: totalFirstVisits } = await supabase
      .from('referrals')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'first_visit');

    const { data: pointsSumData } = await supabase
      .from('referral_transactions')
      .select('amount');

    const totalPointsAwarded = (pointsSumData || []).reduce((acc, curr) => acc + curr.amount, 0);

    res.json({
      transactions: (transactions || []).map(tx => ({
        id: tx.id,
        amount: tx.amount,
        type: tx.type,
        created_at: tx.created_at,
        referrer_name: tx.user?.name || 'Система',
        referee_name: tx.referee?.name || 'Новый друг',
      })),
      analytics: {
        total_invitations: totalReferrals || 0,
        successful_registrations: totalReferrals || 0,
        first_visits: totalFirstVisits || 0,
        total_points_awarded: totalPointsAwarded || 0
      }
    });
  } catch (err) {
    next(err);
  }
});

// ─── Company Profile Customization ──────────────────────────────
const companyProfileSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  phone: z.string().min(1),
  address: z.string().min(1),
  coordinates: z.string().min(1),
  working_hours: z.string().min(1),
  logo_url: z.string().optional().nullable(),
  carousel_urls: z.array(z.string()),
});

router.put('/company/profile', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) return res.status(403).json({ error: 'Нет доступа' });
    const parsed = companyProfileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { data, error } = await supabase
      .from('company_profile')
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString()
      })
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .select()
      .single();

    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    next(err);
  }
});

// ─── Work Examples ──────────────────────────────────────────────
const workExampleSchema = z.object({
  service_id: z.string().uuid().optional().nullable(),
  description: z.string().min(1),
  photo_url: z.string().min(1),
});

router.get('/work-examples', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('work_examples')
      .select(`
        id, description, photo_url, created_at, service_id,
        service:services (id, title)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ work_examples: data || [] });
  } catch (err) {
    next(err);
  }
});

router.post('/work-examples', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) return res.status(403).json({ error: 'Нет доступа' });
    const parsed = workExampleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { data, error } = await supabase
      .from('work_examples')
      .insert(parsed.data)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ work_example: data });
  } catch (err) {
    next(err);
  }
});

router.delete('/work-examples/:id', async (req, res, next) => {
  try {
    if (!isAdminOrModerator(req)) return res.status(403).json({ error: 'Нет доступа' });
    const { id } = req.params;

    const { error } = await supabase
      .from('work_examples')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
