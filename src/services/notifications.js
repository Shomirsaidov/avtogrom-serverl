import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { supabase } from '../supabase.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serviceAccountPath = join(__dirname, '../../config/firebase-service-account.json');

let firebaseApp = null;
let isMock = true;

try {
  let serviceAccount = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  }

  if (serviceAccount) {
    firebaseApp = initializeApp({
      credential: cert(serviceAccount)
    });
    isMock = false;
    console.log('[Notification Service] Firebase Admin initialized successfully using service account.');
  } else {
    console.log('[Notification Service] Firebase credentials not found. Running in MOCK mode.');
  }
} catch (err) {
  console.error('[Notification Service] Failed to initialize Firebase Admin, falling back to MOCK mode:', err);
}

async function sendPush(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;

  if (isMock) {
    console.log(`[Mock FCM Push] Sending to ${tokens.length} tokens. Title: "${title}", Body: "${body}", Data:`, data);
    return;
  }

  try {
    const message = {
      notification: { title, body },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    const messaging = getMessaging();

    if (tokens.length === 1) {
      await messaging.send({
        ...message,
        token: tokens[0]
      });
    } else {
      const payload = {
        ...message,
        tokens: tokens
      };
      await messaging.sendEachForMulticast(payload);
    }
    console.log(`[FCM Push] Sent successfully to ${tokens.length} tokens.`);
  } catch (err) {
    console.error('[FCM Push] Failed to send push:', err);
  }
}

/**
 * Sends a notification to a specific user or guest.
 * Writes to public.notifications table and triggers push notification.
 */
export async function sendNotification({ userId, customerPhone, type, title, body, relatedId = null }) {
  try {
    // 1. Insert into notifications table
    const { data: notification, error: dbErr } = await supabase
      .from('notifications')
      .insert({
        user_id: userId || null,
        customer_phone: customerPhone || null,
        title,
        body,
        type,
        related_id: relatedId,
        is_read: false
      })
      .select()
      .single();

    if (dbErr) throw dbErr;

    // 2. Fetch device tokens for the user
    let tokens = [];
    if (userId) {
      const { data: tokenRows, error: tokenErr } = await supabase
        .from('user_notification_tokens')
        .select('token')
        .eq('user_id', userId);

      if (tokenErr) {
        console.error('[Notification Service] Failed to fetch device tokens:', tokenErr);
      } else if (tokenRows) {
        tokens = tokenRows.map(r => r.token);
      }
    }

    // 3. Send push if tokens found
    if (tokens.length > 0) {
      await sendPush(tokens, title, body, {
        notification_id: notification.id,
        type,
        related_id: relatedId || '',
      });
    }

    return notification;
  } catch (err) {
    console.error('[Notification Service] sendNotification error:', err);
  }
}

/**
 * Broadcasts a notification to all Admin and Moderator users.
 */
export async function sendNotificationToStaff({ type, title, body, relatedId = null }) {
  try {
    const { data: staff, error: staffErr } = await supabase
      .from('users')
      .select('id')
      .in('role', ['admin', 'moderator']);

    if (staffErr) throw staffErr;
    if (!staff || staff.length === 0) return;

    for (const member of staff) {
      await sendNotification({
        userId: member.id,
        type,
        title,
        body,
        relatedId
      });
    }
  } catch (err) {
    console.error('[Notification Service] sendNotificationToStaff error:', err);
  }
}
