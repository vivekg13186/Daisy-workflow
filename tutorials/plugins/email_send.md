# email.send

This plugin sends emails via SMTP. It is highly flexible, supporting HTML content, multiple recipients (To, CC, BCC), attachments, and custom headers. It also includes a "dry-run" mode for testing without sending actual emails.

## Prerequisites
* **SMTP Server:** Access to an SMTP provider (e.g., SendGrid, Mailgun, AWS SES, or Gmail).
* **Environment Variables:** By default, the plugin looks for `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`.
* **Testing Tool:** Set `smtp.host: "json"` in the inputs to perform a dry-run. This will return the rendered email content in the `preview` output without hitting a real server.

## SMTP Provider Setup Examples

### 1. SendGrid Setup
To use SendGrid, you must create an API Key with "Mail Send" permissions.
* **Host:** `smtp.sendgrid.net`
* **Port:** `587` (or `465` for SSL)
* **User:** `apikey` (This is a literal string)
* **Pass:** `YOUR_SENDGRID_API_KEY`

```yaml
    inputs:
      - smtp:
          host: "smtp.sendgrid.net"
          port: 587
          user: "apikey"
          pass: "SG.your_api_key_here"
```

### 2. Gmail Setup
For Gmail, you **cannot** use your regular account password if 2FA is enabled. You must generate an **App Password**.
1. Go to your [Google Account Security settings](https://myaccount.google.com/security).
2. Enable 2-Step Verification.
3. Search for "App Passwords."
4. Generate a new password for "Mail" and "Other."
* **Host:** `smtp.gmail.com`
* **Port:** `465` (Secure: true) or `587` (Secure: false)
* **User:** `your-email@gmail.com`
* **Pass:** `abcd-efgh-ijkl-mnop` (The 16-character app password)

```yaml
    inputs:
      - smtp:
          host: "smtp.gmail.com"
          port: 465
          secure: true
          user: "your-email@gmail.com"
          pass: "abcd-efgh-ijkl-mnop"
```

---

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `to` | Recipient email address(es). | `["user@example.com"]` |
| `subject` | The email subject line. | `Action Required: Order #123` |
| `text` | Plain text version of the message. | `Hello, your order is ready.` |
| `html` | HTML version of the message. | `<h1>Hello</h1><p>Your order is <b>ready</b>.</p>` |
| `from` | Sender email address. | `notifications@yourdomain.com` |
| `attachments` | Array of objects (path or content). | `[{"filename": "invoice.pdf", "path": "./files/inv.pdf"}]` |
| `smtp` | Object to override default SMTP settings. | `{"host": "smtp.mailtrap.io", "port": 587}` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `messageId` | Unique identifier for the sent email. | `<unique-id@server.com>` |
| `accepted` | List of addresses that accepted the mail. | `["user@example.com"]` |
| `response` | The raw SMTP response string. | `250 2.0.0 OK` |
| `preview` | The rendered MIME message (dry-run only). | `Content-Type: text/plain...` |

## Sample workflow
```yaml
name: send-welcome-email
nodes:
  - name: send_welcome
    action: email.send
    inputs:
      - to: "newbie@example.com"
      - subject: "Welcome to our Platform!"
      - html: "<h1>Welcome!</h1>"
      - smtp:
          host: "smtp.sendgrid.net"
          port: 587
          user: "apikey"
          pass: "${process.env.SENDGRID_API_KEY}"
    outputs:
      - messageId: sentId
```

## Troubleshooting
* **Gmail Auth:** Use an **App Password**. Standard passwords will result in a `535 5.7.8` Authentication Failed error.
* **SendGrid Auth:** Ensure the username is exactly `apikey` (all lowercase).
* **Connection Timeout:** Ensure the SMTP port is not blocked by your cloud provider (e.g., AWS/GCP often block port 25).

## Library
* `nodemailer` - The industry-standard Node.js library for sending emails.
