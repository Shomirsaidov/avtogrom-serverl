import { supabase } from '../supabase.js';
import { sendNotification } from './notifications.js';

/**
 * Handles logic when a new user registers with a referral link.
 * Credits points to both referee and referrer.
 */
export async function handleReferralSignup(refereeId, referrerId) {
  try {
    // 1. Verify referrer exists
    const { data: referrer, error: refErr } = await supabase
      .from('users')
      .select('id, name')
      .eq('id', referrerId)
      .maybeSingle();

    if (refErr || !referrer) {
      console.warn(`[Referral Service] Referrer ${referrerId} not found, skipping signup referral.`);
      return;
    }

    // 2. Prevent self-referral
    if (refereeId === referrerId) {
      console.warn(`[Referral Service] Self-referral is not allowed.`);
      return;
    }

    // 3. Check if referee is already referred
    const { data: existingRef } = await supabase
      .from('referrals')
      .select('id')
      .eq('referee_id', refereeId)
      .maybeSingle();

    if (existingRef) {
      console.warn(`[Referral Service] Referee ${refereeId} is already referred, skipping.`);
      return;
    }

    // 4. Fetch referral settings
    const { data: settings } = await supabase
      .from('referral_settings')
      .select('*')
      .maybeSingle();

    const isEnabled = settings ? settings.enabled : true;
    const signupReward = settings ? settings.signup_reward : 100;
    const referrerSignupReward = settings ? settings.referrer_signup_reward : 50;

    // 5. Create referral record
    const { error: insertErr } = await supabase
      .from('referrals')
      .insert({
        referrer_id: referrerId,
        referee_id: refereeId,
        status: 'registered'
      });

    if (insertErr) throw insertErr;

    if (!isEnabled) {
      console.log(`[Referral Service] Referral program is disabled. Record created without points.`);
      return;
    }

    // 6. Award Referee Signup Bonus
    if (signupReward > 0) {
      await supabase
        .from('referral_transactions')
        .insert({
          user_id: refereeId,
          amount: signupReward,
          type: 'signup_bonus',
          referee_id: refereeId
        });

      // Increment referee's points
      const { data: refereeUser } = await supabase
        .from('users')
        .select('bonus_points')
        .eq('id', refereeId)
        .maybeSingle();

      const newRefereePoints = (refereeUser?.bonus_points || 0) + signupReward;
      await supabase
        .from('users')
        .update({ bonus_points: newRefereePoints })
        .eq('id', refereeId);
    }

    // 7. Award Referrer Signup Bonus
    if (referrerSignupReward > 0) {
      await supabase
        .from('referral_transactions')
        .insert({
          user_id: referrerId,
          amount: referrerSignupReward,
          type: 'referee_signup_bonus',
          referee_id: refereeId
        });

      // Increment referrer's points
      const { data: referrerUser } = await supabase
        .from('users')
        .select('bonus_points')
        .eq('id', referrerId)
        .maybeSingle();

      const newReferrerPoints = (referrerUser?.bonus_points || 0) + referrerSignupReward;
      await supabase
        .from('users')
        .update({ bonus_points: newReferrerPoints })
        .eq('id', referrerId);

      // Fetch referee's name to display in notification
      const { data: referee } = await supabase
        .from('users')
        .select('name')
        .eq('id', refereeId)
        .maybeSingle();

      const refereeName = referee?.name || 'Новый друг';

      // Send push notification to referrer
      await sendNotification({
        userId: referrerId,
        type: 'referral_signup',
        title: 'Бонус за друга! 🎁',
        body: `${refereeName} зарегистрировался по вашей ссылке. Вам начислено +${referrerSignupReward} баллов.`,
        relatedId: refereeId
      });
    }

    console.log(`[Referral Service] Signup referral processed. Referee: ${refereeId}, Referrer: ${referrerId}`);
  } catch (err) {
    console.error('[Referral Service] handleReferralSignup error:', err);
  }
}

/**
 * Handles logic when a referee completes their first booking.
 * Credits points to the referrer.
 */
export async function handleFirstVisit(refereeId) {
  try {
    // 1. Look up referral record
    const { data: referral, error: fetchErr } = await supabase
      .from('referrals')
      .select('*')
      .eq('referee_id', refereeId)
      .eq('status', 'registered')
      .maybeSingle();

    if (fetchErr || !referral) {
      // Not a referred user or already processed
      return;
    }

    // 2. Fetch referral settings
    const { data: settings } = await supabase
      .from('referral_settings')
      .select('*')
      .maybeSingle();

    const isEnabled = settings ? settings.enabled : true;
    const referrerFirstVisitReward = settings ? settings.referrer_first_visit_reward : 200;

    // 3. Update status of referral to 'first_visit'
    await supabase
      .from('referrals')
      .update({ status: 'first_visit' })
      .eq('id', referral.id);

    if (!isEnabled) {
      console.log(`[Referral Service] Referral program is disabled. Status updated to first_visit without points.`);
      return;
    }

    // 4. Award Referrer First Visit Bonus
    if (referrerFirstVisitReward > 0) {
      const referrerId = referral.referrer_id;

      await supabase
        .from('referral_transactions')
        .insert({
          user_id: referrerId,
          amount: referrerFirstVisitReward,
          type: 'referee_first_visit_bonus',
          referee_id: refereeId
        });

      // Increment referrer's points
      const { data: referrerUser } = await supabase
        .from('users')
        .select('bonus_points')
        .eq('id', referrerId)
        .maybeSingle();

      const newPoints = (referrerUser?.bonus_points || 0) + referrerFirstVisitReward;
      await supabase
        .from('users')
        .update({ bonus_points: newPoints })
        .eq('id', referrerId);

      // Fetch referee's name to display in notification
      const { data: referee } = await supabase
        .from('users')
        .select('name')
        .eq('id', refereeId)
        .maybeSingle();

      const refereeName = referee?.name || 'Друг';

      // Send push notification to referrer
      await sendNotification({
        userId: referrerId,
        type: 'referral_first_visit',
        title: 'Первый визит друга! 🚗',
        body: `${refereeName} совершил свой первый визит. Вам начислено +${referrerFirstVisitReward} баллов!`,
        relatedId: refereeId
      });
    }

    console.log(`[Referral Service] First visit referral processed for referee: ${refereeId}`);
  } catch (err) {
    console.error('[Referral Service] handleFirstVisit error:', err);
  }
}
