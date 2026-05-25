import { supabase } from '../supabase.js';

const SLOT_STEP_MINUTES = 30;

function parseTimeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function dayOfWeekIsoToDb(jsDay) {
  // JS getDay(): 0=Sun..6=Sat. We store the same convention.
  return jsDay;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Builds the UTC ISO timestamp for a wall-clock minute-of-day on the given local date.
// For MVP we treat dates as UTC-naive (the date string sent from the client is the local date,
// and slot times are interpreted as the shop's local time, persisted as timestamptz).
// We use UTC math here for determinism; later when multi-tenant lands we will store a shop tz.
function buildTimestamp(dateStr, minutes) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(m)}:00.000Z`;
}

export async function getAvailableSlots({ specialistId, dateStr, durationMinutes }) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    const err = new Error('Invalid date');
    err.status = 400;
    throw err;
  }
  const dayOfWeek = dayOfWeekIsoToDb(date.getUTCDay());

  const { data: schedules, error: scheduleErr } = await supabase
    .from('specialist_schedules')
    .select('start_time,end_time')
    .eq('specialist_id', specialistId)
    .eq('day_of_week', dayOfWeek);

  if (scheduleErr) throw scheduleErr;
  if (!schedules || schedules.length === 0) return [];

  const dayStart = buildTimestamp(dateStr, 0);
  const dayEnd = buildTimestamp(dateStr, 24 * 60);

  const { data: bookings, error: bookingsErr } = await supabase
    .from('bookings')
    .select('scheduled_at,duration_minutes,status')
    .eq('specialist_id', specialistId)
    .gte('scheduled_at', dayStart)
    .lt('scheduled_at', dayEnd)
    .neq('status', 'cancelled');

  if (bookingsErr) throw bookingsErr;

  const busy = (bookings || []).map((b) => {
    const start = new Date(b.scheduled_at);
    const startMin =
      start.getUTCHours() * 60 + start.getUTCMinutes();
    return { startMin, endMin: startMin + b.duration_minutes };
  });

  const slots = [];
  for (const s of schedules) {
    const windowStart = parseTimeToMinutes(s.start_time);
    const windowEnd = parseTimeToMinutes(s.end_time);
    for (let t = windowStart; t + durationMinutes <= windowEnd; t += SLOT_STEP_MINUTES) {
      const slotEnd = t + durationMinutes;
      const overlaps = busy.some((b) => t < b.endMin && slotEnd > b.startMin);
      if (!overlaps) {
        slots.push({
          start: buildTimestamp(dateStr, t),
          label: `${pad(Math.floor(t / 60))}:${pad(t % 60)}`,
        });
      }
    }
  }
  return slots;
}

export async function isSlotStillFree({ specialistId, scheduledAt, durationMinutes }) {
  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  const { data, error } = await supabase
    .from('bookings')
    .select('scheduled_at,duration_minutes')
    .eq('specialist_id', specialistId)
    .neq('status', 'cancelled')
    .gte('scheduled_at', new Date(start.getTime() - 24 * 60 * 60_000).toISOString())
    .lte('scheduled_at', end.toISOString());

  if (error) throw error;

  for (const b of data || []) {
    const bStart = new Date(b.scheduled_at);
    const bEnd = new Date(bStart.getTime() + b.duration_minutes * 60_000);
    if (start < bEnd && end > bStart) return false;
  }
  return true;
}
