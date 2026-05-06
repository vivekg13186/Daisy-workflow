# Email Trigger Guide: Testing with Docker & IMAP

This guide provides a complete walkthrough for setting up a local testing environment for the **Email Trigger**. You will learn how to run a mock IMAP server using Docker, configure the trigger, and build a workflow to process incoming emails.

---

## 1. Setup a Local IMAP Server (Docker)

To test the trigger without using a real email account, we use **GreenMail**, a specialized open-source email sandboxing tool.

### Start the Docker Container
Run the following command in your terminal to start a mock SMTP and IMAP server:

```bash
docker run -d \
  -p 3025:3025 \
  -p 3143:3143 \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.users=test:pass@example.com" \
  --name email-test-server \
  greenmail/standalone:latest
```

### Server Details:
* **IMAP Port:** `3143`
* **SMTP Port:** `3025`
* **User:** `test@example.com`
* **Password:** `pass`
* **Secure:** `false` (Plain text/STARTTLS for testing)

---

## 2. Setting to Send Mail (Test Injection)

To "fire" the trigger, you need to send an email to the Docker container. You can use the `email.send` plugin or a script to hit the SMTP port.

**Configuration for Sending:**
* **Host:** `localhost`
* **Port:** `3025`
* **User:** `test@example.com`
* **Pass:** `pass`

---

## 3. Configure the Email Trigger

In your workflow engine, set up the **Email Trigger** node with the following configuration to connect to your Docker container.

### Config Settings:
| Field | Value |
| :--- | :--- |
| **Host** | `localhost` |
| **Port** | `3143` |
| **User** | `test@example.com` |
| **Pass** | `pass` |
| **Secure** | `false` |
| **Mailbox** | `INBOX` |
| **MarkAsSeen**| `true` |

---

## 4. Workflow Example

This workflow logs the subject and text content whenever a new email is detected.

```yaml
name: log-incoming-emails
description: Watches the test inbox and logs content.

trigger:
  action: email.trigger
  config:
    host: "localhost"
    port: 3143
    user: "test@example.com"
    pass: "pass"
    secure: false

nodes:
  - name: log_email_data
    action: log
    inputs:
      - message: |
          New Email Received!
          From: ${trigger.payload.from[0]}
          Subject: ${trigger.payload.subject}
          Content: ${trigger.payload.text}
```

---

## 5. Troubleshooting Steps

If the trigger isn't firing, check these items in order:

### A. Check if Docker is running
Run `docker ps`. You should see `email-test-server` in the list. If not, restart it using `docker start email-test-server`.

### B. Verify Connectivity (Telnet/NC)
Test if the IMAP port is actually open:
```bash
# For IMAP
telnet localhost 3143
```
If you see `* OK GreenMail ready`, the server is reachable.

### C. Check the Connection Logs
The trigger code has `emitLogs: true` enabled. Look at your workflow runner console output.
* **"Connect mail":** Means the plugin is attempting to open the socket.
* **"exists" events:** If you see `exists` in the logs but no execution, ensure the email is marked as `Unseen` in the mailbox.

### D. Certificate Issues
If testing against a real server with self-signed certs, ensure the following is in your code (already included in the provided script):
```javascript
tls: {
  rejectUnauthorized: false
}
```

---

## Technical Reference: Payload Structure
When an email is received, the trigger provides:
* `from`: Array of sender addresses.
* `subject`: Email subject string.
* `text`: Plain text body.
* `html`: HTML body.
* `attachments`: Array of `{ filename, contentType, size }`.
