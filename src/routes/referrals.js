import { Router } from 'express';
import { supabase } from '../supabase.js';
import { requireAuth } from '../auth/middleware.js';

const router = Router();

// All client referral endpoints require auth
router.use(requireAuth);

// GET /api/referrals/summary
router.get('/summary', async (req, res, next) => {
  try {
    const userId = req.user.sub;

    // 1. Fetch user's current points balance
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('bonus_points')
      .eq('id', userId)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    // 2. Fetch referrals made by this user
    const { data: referrals, error: refErr } = await supabase
      .from('referrals')
      .select(`
        id,
        status,
        created_at,
        referee:users (id, name, created_at)
      `)
      .eq('referrer_id', userId)
      .order('created_at', { ascending: false });

    if (refErr) throw refErr;

    const formattedReferrals = (referrals || []).map((r) => ({
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      referee_name: r.referee?.name || 'Новый друг',
      referee_registered_at: r.referee?.created_at || r.created_at,
    }));

    res.json({
      referral_code: userId,
      bonus_points: user.bonus_points || 0,
      referrals: formattedReferrals
    });
  } catch (err) {
    next(err);
  }
});

export default router;
