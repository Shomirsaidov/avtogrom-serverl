import { Router } from 'express';
import { supabase } from '../supabase.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('services')
      .select('id,title,description,price_from,price_fixed,duration_minutes,photo_url')
      .order('title', { ascending: true });
    if (error) throw error;
    res.json({ services: data });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: service, error: serviceErr } = await supabase
      .from('services')
      .select('id,title,description,price_from,price_fixed,duration_minutes,photo_url')
      .eq('id', id)
      .maybeSingle();
    if (serviceErr) throw serviceErr;
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const { data: links, error: linkErr } = await supabase
      .from('service_specialists')
      .select('specialist:specialists(id,full_name,photo_url,specialization,bio)')
      .eq('service_id', id);
    if (linkErr) throw linkErr;

    const specialists = (links || []).map((l) => l.specialist).filter(Boolean);
    res.json({ service, specialists });
  } catch (err) {
    next(err);
  }
});

export default router;
