# SMS Aero API Reference (OTP Integration)

This document contains only the SMS Aero API information required to implement phone number verification via one-time passwords (OTP).

---

# Base URL

```text
https://gate.smsaero.ru/v2
```

---

# Authentication

SMS Aero uses HTTP Basic Authentication.

Use your SMS Aero account email as the username and your API key as the password.

## Header

```http
Authorization: Basic <base64(email:api_key)>
```

Example:

```text
email: developer@example.com
api_key: xxxxxxxxxxxxxxxxx
```

Encoded:

```http
Authorization: Basic ZGV2ZWxvcGVyQGV4YW1wbGUuY29tOnh4eHh4eHh4eHh4
```

---

# Environment Variables

```env
SMS_AERO_BASE_URL=https://gate.smsaero.ru/v2
SMS_AERO_EMAIL=developer@example.com
SMS_AERO_API_KEY=xxxxxxxxxxxxxxxx
SMS_AERO_SIGN=MyApp
```

---

# Send SMS

Sends a single SMS message.

## Endpoint

```http
POST /sms/send
```

---

## Request Body

| Field  | Type   | Required | Description                                                |
| ------ | ------ | -------- | ---------------------------------------------------------- |
| number | string | Yes      | Recipient phone number in international format without `+` |
| text   | string | Yes      | SMS message text                                           |
| sign   | string | Yes      | Approved sender name (signature)                           |

---

## Example Request

```http
POST https://gate.smsaero.ru/v2/sms/send
Authorization: Basic <credentials>
Content-Type: application/json
```

```json
{
  "number": "79991234567",
  "text": "Your verification code is: 482193",
  "sign": "MyApp"
}
```

---

## Successful Response

```json
{
  "success": true,
  "data": {
    "id": 123456789,
    "status": 1
  }
}
```

---

## Response Fields

| Field       | Description                    |
| ----------- | ------------------------------ |
| success     | Request completed successfully |
| data.id     | SMS identifier                 |
| data.status | Initial delivery status        |

---

# SMS Status Codes

| Status | Meaning                          |
| ------ | -------------------------------- |
| 1      | Queued / accepted for processing |
| 2      | Sent                             |
| 8      | Delivered                        |
| 6      | Delivery failed                  |

---

# OTP Message Example

```text
Your verification code is: 482193

The code expires in 5 minutes.
```

---

# Error Handling

Treat the request as failed if:

* HTTP status is not 200
* `success` is `false`
* Response contains an error message

Do not retry requests caused by:

* Invalid credentials
* Invalid sender name
* Invalid phone number
* Insufficient account balance

Retry only temporary failures such as:

* Network timeout
* Connection error
* Temporary server error (5xx)

---

# Phone Number Format

Use international format without the `+` sign.

Example:

```text
79991234567
```

---

# Sender Name

The `sign` value must be an approved sender name registered in your SMS Aero account.

Example:

```text
MyApp
```

---

# Content-Type

```http
Content-Type: application/json
```

---

# OTP Recommendations

Recommended OTP length:

```text
6 digits
```

Recommended expiration:

```text
5 minutes
```

Recommended maximum verification attempts:

```text
5
```

Recommended resend interval:

```text
60 seconds
```

---

# Example cURL

```bash
curl -X POST "https://gate.smsaero.ru/v2/sms/send" \
-u "developer@example.com:API_KEY" \
-H "Content-Type: application/json" \
-d '{
  "number":"79991234567",
  "text":"Your verification code is: 482193",
  "sign":"MyApp"
}'
```
