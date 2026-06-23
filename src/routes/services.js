import { Router } from 'express';
import { supabase } from '../supabase.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const search = req.query.search?.trim();
    let query = supabase
      .from('services')
      .select('id,title,description,price_from,price_fixed,duration_minutes,photo_url,discount_tag,discount_price')
      .order('title', { ascending: true });
    if (search) {
      query = query.ilike('title', `%${search}%`);
    }
    const { data, error } = await query;
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
      .select('id,title,description,price_from,price_fixed,duration_minutes,photo_url,discount_tag,discount_price')
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

    const { data: workExamples, error: workExamplesErr } = await supabase
      .from('work_examples')
      .select('id,description,photo_url,created_at')
      .eq('service_id', id)
      .order('created_at', { ascending: false });

    if (workExamplesErr) throw workExamplesErr;

    res.json({ service, specialists, work_examples: workExamples || [] });
  } catch (err) {
    next(err);
  }
});

export default router;
