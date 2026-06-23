import { Router } from 'express';
import { supabase } from '../supabase.js';

const router = Router();

// GET /api/company/profile
router.get('/profile', async (req, res, next) => {
  try {
    const { data: profile, error } = await supabase
      .from('company_profile')
      .select('*')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .maybeSingle();

    if (error) throw error;
    if (!profile) return res.status(404).json({ error: 'Профиль компании не найден' });

    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

// GET /api/company/work-examples
router.get('/work-examples', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('work_examples')
      .select('id, description, photo_url, created_at, service_id')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ work_examples: data || [] });
  } catch (err) {
    next(err);
  }
});

export default router;
