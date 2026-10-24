# 🍽️ Mess QR Selling Bot

Automated WhatsApp bot for selling mess meal QR codes with scheduled price drops, interactive DM buyer queues, smart negotiation, and loyalty rewards.

---

## 💡 Motivation Behind Building

At IIIT Hyderabad, mess policies enforce strict cancellation limits: a maximum of **5 cancellations per meal per month**, requiring at least **24 hours prior cancellation**. In reality, student schedules are unpredictable—late-night study sessions routinely lead to sleeping through breakfast, and impromptu plans leave paid meals untouched. With no administrative recourse for last-minute changes, students incur a quiet, routine financial leak.

### The Flawed Manual Workaround
Students improvised by selling unused meal QRs over WhatsApp groups, but the manual process suffered from severe friction:
- **High Attention Overhead**: Sellers had to babysit chat threads, field repetitive DMs, negotiate prices, share UPI credentials, verify transactions, and send QR images.
- **The Babysitting Bottleneck**: If a seller fell asleep, attended class, or stepped away, the listing sat idle, buyers messaged into a void, and the meal expired unused anyway.
- **Coordination Lag**: Forgetting to manually mark messages as sold (e.g., reacting with ✅) caused confusion and wasted everyone's time.

### The Autonomous "Vending Machine" Solution
This bot closes the gap between an unusable meal and someone looking for a quick bite by turning a chaotic manual hustle into a zero-touch vending machine:
1. **Scheduled Dynamic Drops**: Automatically broadcasts listings to target groups with gradual price decrements as meal cutoffs approach.
2. **Intent Recognition & Fair Queuing**: Parses buyer intent (`buy`, `want`), queues buyers fairly, and enforces inactivity timeouts to prevent stalled sales.
3. **Automated Negotiation**: Concludes deals within pre-configured margins or defends fixed pricing without manual intervention.
4. **Zero-Touch Fulfillment**: Auto-detects payments (WhatsApp Pay, screenshots, or `DONE`), instantly delivers the QR image, reacts with ✅ in the group, and supports rollback (`TESTING`).

> **Drop the QR once, walk away, and let the system handle pricing, negotiation, and delivery.** Students recover sunk meal costs without losing sleep or study hours.

---

## ⚡ Features

- **Scheduled Group Drops**: Automatically posts sell messages to target groups across configured meal intervals with dropping prices.
- **Smart Negotiation**:
  - **Negotiation ON**: Automatically accepts offers within margin or counter-offers the minimum acceptable price with payment instructions.
  - **Negotiation OFF**: Politely informs the buyer that price is fixed and sends payment instructions.
- **Verified Payments**: The buyer must send a **payment screenshot**. Claude reads it (amount, payee, status, time, UTR) and the bot checks it against the price, your UPI ID/name, a 30-minute window, and a ledger of used UTRs. Only after it's verified does replying **DONE** release the QR. Screenshots that fail are forwarded to `ADMIN_NUMBER`, who replies **APPROVE** or **REJECT**.
- **Resilient QR Delivery**: Delivers QR directly via active chat with automatic format fallbacks and WhatsApp Web memoization shields.
- **Group Message Reactions**: Marks group sell messages with ✅ when sold; cleans them up automatically if reverted via `TESTING`.
- **Loyalty / Free Meal System**: Tracks buyer spend in CSV; automatically awards a free meal once the loyalty threshold is reached.
- **Live Blocklist**: Completely ignores blocked numbers; auto-reloads changes without restarting.

---

## 🚀 Quick Start

### 1. Requirements & Install
- **Node.js 18+**
```bash
npm install
```

### 2. Add Your QR Code
Drop your mess QR image (`.png`, `.jpg`, or `.jpeg`) into the `utils/` folder (e.g. `utils/qr.png`).

### 3. Configure
Copy `Setting.example.txt` to `Setting.txt` (it's git-ignored, so your details stay local) and set:
- `GROUP_NAME`: Comma-separated text; the bot posts in every group whose name contains any of it.
- `UPI_ID` & `PAYEE_NAME`: Your UPI ID and name exactly as buyers' payment screenshots show them.
- `BOT_NUMBER` / `ADMIN_NUMBER`: The WhatsApp number the bot runs on, and who gets screenshots it can't verify.
- `PRICE_SCHEDULE`: Price by time of day, e.g. `07:30=25, 09:00=20, 09:15=15`.
- `NEGOTIATION_SCHEDULE`: Lowest price you'll accept by time, e.g. `07:30=none, 08:30=20, 09:00=15, 09:15=10`.
- `TESTING`: `true` posts only in groups matching `TESTING_GROUP_NAME`, every 2 minutes.

Copy `.env.example` to `.env` and set `DINING_API_KEY` (dining.iiit.ac.in → Settings → API keys) so the meal QR is fetched every morning. `ANTHROPIC_API_KEY` is optional — screenshots are read by free on-PC OCR by default.

### How a sale works
1. The first person to DM "buy"/"want" gets the price, your UPI ID and UPI QR. Later buyers wait silently in line.
2. Only if they ask, they can bargain — never below that time's `NEGOTIATION_SCHEDULE` floor.
3. They confirm with **YES** / "paying" / 👍. The meal is then held for them for `PAYMENT_WINDOW_MINUTES`.
4. They send the payment screenshot. OCR checks: exact agreed amount, paid to you, success status, an unused UTR, and paid between the price agreement and the end of the window.
5. They reply **DONE** and get the meal QR; everyone still waiting is told it's sold. If they don't pay in time, the next person in line gets the offer.

### 4. Run
```bash
node main.js
```
- First run: Scan the WhatsApp Web QR in your terminal.
- Use interactive menu to choose meal type, mess, price, and negotiation.

---

## 🎁 Free Meal / Loyalty Program

The bot tracks customer loyalty automatically in `utils/purchases.csv`:

- **How it works**: Every successful purchase logs `phone,name,total_spent,last_updated`.
- **Free Meal Trigger**: When a buyer's `total_spent` reaches or crosses `LOYALTY_TARGET` (default ₹180):
  - Their next meal is **100% FREE**.
  - The bot alerts them not to pay and claim the QR directly by replying `DONE`.
  - Once claimed, their `total_spent` resets to ₹0.
- **Testing Revert**: If the buyer was just testing and sends `TESTING`, the purchase is reverted and their previous spend is restored.

---

## ⛔ Blocklist

Manage blocked contacts in `utils/blocklist.csv`:

- **Format**: Add phone numbers one per line. Spaces, dashes, and `+91` are automatically normalized:
  ```csv
  # Blocked numbers (one per line)
  9876543210
  +91-9123456789
  ```
- **Behavior**: Blocked users are completely ignored (no replies, no queueing, no stats impact).
- **Hot-Reload**: The file is re-checked every 5 seconds — updates apply immediately without restarting the bot.

---

## ⚙️ Key Configuration (`Setting.txt`)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `ENABLE_NEGOTIATION` | Enable price bargaining in DMs (`true`/`false`) | `false` |
| `NEGOTIATION_MARGIN` | Maximum discount acceptable below current price | `5` |
| `BUYER_INACTIVITY_MS` | Buyer checkout timeout window | `90000` (90s) |
| `BUYER_TIMEOUT_WARNING_MS` | Timeout reminder warning window | `30000` (30s) |
| `LOYALTY_TARGET` | Total spend required to earn a free meal | `180` |
| `TESTING` | Bypass meal schedule timers for instant testing | `false` |

---

## 🛑 Stop

Press `Ctrl + C` in terminal for graceful shutdown and timer cleanup.
