import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../supabase.js';
import { requireAuth } from '../auth/middleware.js';
import { handleReferralSignup } from '../services/referrals.js';
import { sendSMS } from '../services/sms.js';
import { generateOTP, verifyOTP } from '../services/otp.js';
import { normalizePhoneNumber } from '../utils/phone.js';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(6).max(100),
  referred_by: z.string().optional().nullable(),
  phone: z.string().min(5).max(30).optional().nullable(),
  code: z.string().length(6).optional().nullable(),
});

const loginSchema = z.object({
  identifier: z.string().min(1), // Can be email or phone
  password: z.string().min(1),
});

const otpSendSchema = z.object({
  phone: z.string().min(5).max(30),
});

const phoneVerifySchema = z.object({
  phone: z.string().min(5).max(30),
  code: z.string().length(6),
});

function issueToken(user) {
  return jwt.sign(
    { 
      sub: user.id, 
      email: user.email, 
      name: user.name, 
      phone: user.phone || null, 
      role: user.role, 
      bonus_points: user.bonus_points || 0 
    },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// POST /api/auth/otp/send
router.post('/otp/send', async (req, res, next) => {
  try {
    const parsed = otpSendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { phone } = parsed.data;

    // Generate OTP
    const code = generateOTP(phone);

    // Send SMS
    const text = `Код подтверждения для входа в Автогром (avtogrom.ru): ${code}. Действителен 5 минут.`;
    await sendSMS(phone, text);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-phone (Authenticated)
router.post('/verify-phone', requireAuth, async (req, res, next) => {
  try {
    const parsed = phoneVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { phone, code } = parsed.data;

    // Verify OTP
    const otpResult = verifyOTP(phone, code);
    if (!otpResult.valid) {
      return res.status(400).json({ error: otpResult.message });
    }

    const normalizedPhone = normalizePhoneNumber(phone);

    // Check if phone number is already registered by another user
    const { data: existingPhone } = await supabase
      .from('users')
      .select('id')
      .eq('phone', normalizedPhone)
      .neq('id', req.user.sub)
      .maybeSingle();

    if (existingPhone) {
      return res.status(409).json({ error: 'Этот номер телефона уже используется другим аккаунтом' });
    }

    // Update user's phone in DB
    const { data: user, error } = await supabase
      .from('users')
      .update({ phone: normalizedPhone })
      .eq('id', req.user.sub)
      .select('id, name, email, phone, role, bonus_points')
      .single();

    if (error) throw error;

    res.json({ success: true, user, token: issueToken(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { name, email, password, referred_by, phone, code } = parsed.data;

    // Check email uniqueness
    const { data: existingEmail } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (existingEmail) {
      return res.status(409).json({ error: 'Email уже зарегистрирован' });
    }

    const normalizedPhone = phone ? normalizePhoneNumber(phone) : null;

    // Verify phone if supplied
    if (phone) {
      if (!code) {
        return res.status(400).json({ error: 'Укажите код подтверждения из SMS' });
      }

      // Check phone uniqueness
      const { data: existingPhone } = await supabase
        .from('users')
        .select('id')
        .eq('phone', normalizedPhone)
        .maybeSingle();
      if (existingPhone) {
        return res.status(409).json({ error: 'Этот номер телефона уже зарегистрирован' });
      }

      // Verify OTP
      const otpResult = verifyOTP(phone, code);
      if (!otpResult.valid) {
        return res.status(400).json({ error: otpResult.message });
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: user, error } = await supabase
      .from('users')
      .insert({ 
        name, 
        email, 
        phone: normalizedPhone, 
        password_hash: passwordHash, 
        bonus_points: 0 
      })
      .select('id, name, email, phone, role, bonus_points')
      .single();
    if (error) throw error;

    // Trigger referral signup if referred
    if (referred_by) {
      // Run in background to not block response
      (async () => {
        try {
          await handleReferralSignup(user.id, referred_by);
        } catch (err) {
          console.error('[Referral Hook Error in register]', err);
        }
      })();
    }

    res.status(201).json({ user, token: issueToken(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { identifier, password } = parsed.data;

    const isEmail = identifier.includes('@');
    let query = supabase.from('users').select('id, name, email, phone, role, password_hash, bonus_points');

    if (isEmail) {
      query = query.eq('email', identifier.trim().toLowerCase());
    } else {
      const normalizedPhone = normalizePhoneNumber(identifier);
      query = query.eq('phone', normalizedPhone);
    }

    const { data: user, error } = await query.maybeSingle();
    if (error) throw error;
    if (!user) {
      return res.status(401).json({ error: 'Неверный email, телефон или пароль' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный email, телефон или пароль' });
    }

    const { password_hash: _, ...safeUser } = user;
    res.json({ user: safeUser, token: issueToken(safeUser) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, phone, role, bonus_points')
      .eq('id', req.user.sub)
      .maybeSingle();
    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

export default router;

