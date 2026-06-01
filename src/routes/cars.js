import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireAuth } from '../auth/middleware.js';

const router = Router();

const upsertCarSchema = z.object({
  make: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  vincode: z.string().max(17).optional().nullable(),
  year: z.number().int().min(1900).max(2100).optional().nullable(),
  license_plate: z.string().max(20).optional().nullable(),
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('cars')
      .select('id, make, model, vincode, year, license_plate, created_at')
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ cars: data });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = upsertCarSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const body = parsed.data;

    const { data: car, error } = await supabase
      .from('cars')
      .insert({
        user_id: req.user.sub,
        make: body.make,
        model: body.model,
        vincode: body.vincode ?? null,
        year: body.year ?? null,
        license_plate: body.license_plate ?? null,
      })
      .select('id, make, model, vincode, year, license_plate, created_at')
      .single();

    if (error) throw error;
    res.status(201).json({ car });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabase
      .from('cars')
      .select('id, user_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Автомобиль не найден' });
    if (existing.user_id !== req.user.sub) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const parsed = upsertCarSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const body = parsed.data;

    const { data: car, error: updateErr } = await supabase
      .from('cars')
      .update({
        make: body.make,
        model: body.model,
        vincode: body.vincode ?? null,
        year: body.year ?? null,
        license_plate: body.license_plate ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, make, model, vincode, year, license_plate, created_at')
      .single();

    if (updateErr) throw updateErr;
    res.json({ car });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabase
      .from('cars')
      .select('id, user_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Автомобиль не найден' });
    if (existing.user_id !== req.user.sub) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const { error: deleteErr } = await supabase
      .from('cars')
      .delete()
      .eq('id', id);

    if (deleteErr) throw deleteErr;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
