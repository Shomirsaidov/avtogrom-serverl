import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getAvailableSlots } from '../services/slots.js';

const router = Router();

const slotsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  duration: z.coerce.number().int().positive(),
});

router.get('/:id/slots', async (req, res, next) => {
  try {
    const parsed = slotsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { id } = req.params;
    const { data: specialist, error } = await supabase
      .from('specialists')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!specialist) return res.status(404).json({ error: 'Specialist not found' });

    const slots = await getAvailableSlots({
      specialistId: id,
      dateStr: parsed.data.date,
      durationMinutes: parsed.data.duration,
    });
    res.json({ slots });
  } catch (err) {
    next(err);
  }
});

export default router;
