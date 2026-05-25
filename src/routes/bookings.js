import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { isSlotStillFree } from '../services/slots.js';

const router = Router();

const createBookingSchema = z.object({
  service_id: z.string().uuid(),
  specialist_id: z.string().uuid(),
  scheduled_at: z.string().datetime(),
  customer_name: z.string().min(1).max(100),
  customer_phone: z.string().min(5).max(30),
});

router.post('/', async (req, res, next) => {
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
      })
      .select('id,service_id,specialist_id,scheduled_at,duration_minutes,status,created_at')
      .single();
    if (insertErr) throw insertErr;

    res.status(201).json({ booking });
  } catch (err) {
    next(err);
  }
});

export default router;
