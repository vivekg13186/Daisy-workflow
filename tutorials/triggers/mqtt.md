# MQTT Trigger Guide: Testing with Docker & Mosquitto

This guide provides a walkthrough for setting up a local **MQTT Broker** using Docker, configuring the **MQTT Trigger**, and testing the flow by publishing messages.

---

## 1. Setup a Local MQTT Broker (Docker)

We will use **Eclipse Mosquitto**, the most popular open-source MQTT broker.

### Start the Docker Container
Run this command to start a broker that allows anonymous connections (for easy local testing):

```bash
docker run -d \
  -p 1883:1883 \
  -p 9001:9001 \
  --name mqtt-broker \
  eclipse-mosquitto:latest \
  mosquitto -c /dev/null --allow-anonymous true --listener 1883 0.0.0.0
```

### Broker Details:
* **Protocol:** `mqtt://`
* **Port:** `1883`
* **Websocket Port:** `9001`
* **Host:** `localhost` (or the IP of your Docker host)

---

## 2. Configure the MQTT Trigger

Set up your trigger to listen to specific topics. MQTT supports wildcards:
* `+` (Single level): `sensors/+/temp` matches `sensors/kitchen/temp`.
* `#` (Multi-level): `sensors/#` matches `sensors/kitchen/temp/celsius`.

### Config Settings:
| Field | Value |
| :--- | :--- |
| **URL** | `mqtt://localhost:1883` |
| **Topic** | `test/topic` (or `sensors/#`) |
| **QoS** | `0` (Fire and forget) or `1` (At least once) |
| **Parse JSON** | `true` (Automatically converts strings to objects) |

---

## 3. Workflow Example

This workflow listens for temperature data and logs it.

```yaml
name: mqtt-sensor-logger
description: Triggers on new MQTT messages and logs the payload.

trigger:
  action: mqtt.trigger
  config:
    url: "mqtt://localhost:1883"
    topic: "home/sensors/temp"

nodes:
  - name: log_payload
    action: log
    inputs:
      - message: |
          MQTT Message Received!
          Topic: ${trigger.payload.topic}
          Value: ${trigger.payload.message}
          Time: ${trigger.payload.receivedAt}
```

---

## 4. Testing the Trigger (Publishing)

To make the trigger fire, you need to "publish" a message to the broker.

### Option A: Using Docker (Command Line)
```bash
docker exec mqtt-broker mosquitto_pub -t "home/sensors/temp" -m '{"value": 22.5, "unit": "C"}'
```

### Option B: Using a GUI Tool
Download **MQTT Explorer** or **MQTT.fx**, connect to `localhost:1883`, and publish a JSON string to your configured topic.

---

## 5. Troubleshooting Steps

### A. Check Broker Status
Run `docker logs mqtt-broker`. You should see logs indicating the broker is listening on port 1883.

### B. Connection Refused
If the trigger cannot connect:
* Ensure no other service is using port 1883.
* If your workflow engine is *also* in Docker, use the host IP or `host.docker.internal` instead of `localhost`.

### C. Message Not Received
* **Topic Mismatch:** MQTT topics are case-sensitive. `Sensors/temp` is not the same as `sensors/temp`.
* **JSON Errors:** If `parseJson` is true but you send malformed JSON, the `message` output will remain a raw string. Check your log node to see the format.

### D. Client ID Conflicts
The code generates a random `clientId`. If you manually set a `clientId`, ensure it is unique. MQTT brokers will disconnect an existing client if a new one connects with the same ID.

---

## Technical Reference: Payload Structure
The trigger provides the following data in the payload:
* `topic`: The specific topic the message arrived on.
* `message`: The parsed JSON object or raw string.
* `qos`: The Quality of Service level (0, 1, or 2).
* `retain`: Boolean indicating if this was a retained message.
* `receivedAt`: ISO timestamp of when the engine received the message.
