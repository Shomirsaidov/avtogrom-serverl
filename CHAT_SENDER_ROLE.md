# Chat sender_role — invariant

`sender_role` in messages is determined by `server/src/routes/conversations.js:173-180`.

## Logic (DO NOT CHANGE LIGHTLY)

```
const isStaff = ['admin', 'moderator', 'system_admin', 'master'].includes(req.user.role);
const isConvOwner = conv.user_id === req.user.sub;
let senderRole = isConvOwner ? 'client' : 'business';
if (parsed.data.sender_role === 'business' && isStaff) {
  senderRole = 'business';
}
```

## Three cases

| Who | Platform | sender_role in body? | isStaff | isConvOwner | Result |
|---|---|---|---|---|---|
| Regular client | mobile app | no | false | true | `'client'` |
| Admin/staff | mobile app | no | true | true | `'client'` (fallback) |
| Admin/staff | admin-chat.html | `'business'` | true | true/false | `'business'` (override) |

**Key**: mobile app never sends sender_role in the request body. Only admin-chat.html sends `sender_role: 'business'`.

## Why not simpler?

The admin user (Abubakr, `089fdc3a...`) owns conversations as `user_id`. In mobile app they should see messages as `'client'` (right side, orange). In admin-chat they should send as `'business'` (right side, orange in admin-chat). The explicit `sender_role` body param from admin-chat disambiguates these two cases.
