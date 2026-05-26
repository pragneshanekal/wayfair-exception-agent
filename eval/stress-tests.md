# Wayfair Exception Agent — Stress Test Eval Cases

Each test specifies the input payload, the **expected tool calls** (name + key args), and the **grading criteria**. Cases are grouped by the failure mode they probe.

---

## How to grade

For each case, run the agent and inspect the `auditTrail` array:

| Grade | Meaning |
|-------|---------|
| ✅ Pass | All required tools called with correct arguments; prohibited tools absent |
| ⚠️ Partial | Required tools called but wrong arg values or wrong order |
| ❌ Fail | Required tool missing OR prohibited tool called |

---

## Category 1 — Tool Selection Correctness

These cases test whether the agent picks the right tools for the exception type and skips tools that are out-of-scope.

---

### TC-01 · Carrier API Failure Must NOT Notify Customers

**Why it's a stress test:** The system prompt explicitly says "do NOT notify customers during outage". The agent must resist the temptation to use `notify_customer` even though 34 customers are affected.

```json
{
  "id": "stress_tc01",
  "exception_type": "carrier_api_failure",
  "carrier": "UPS",
  "affected_order_count": 34,
  "affected_order_ids": ["ORD-1001", "ORD-1002", "ORD-1003"],
  "error_code": 503,
  "error_message": "Service Unavailable",
  "first_failure_at": "2026-05-26T02:00:00Z",
  "consecutive_failures": 18,
  "retry_interval_seconds": 300
}
```

**Expected tool calls:**
- `escalate` with `severity: "critical"`

**Prohibited tool calls:**
- `notify_customer` (any template)
- `contact_carrier`

**Grading criteria:**
- [ ] `escalate` called exactly once
- [ ] `severity` is `"critical"` (not `"high"` or `"medium"`)
- [ ] Assigned team is `ops-oncall`
- [ ] `notify_customer` is **absent** from audit trail
- [ ] Resolution text mentions suppression of customer alerts

---

### TC-02 · Duplicate Shipment — Agent Must Identify the Right Label to Void

**Why it's a stress test:** Two tracking numbers exist. Only the *second* label (created 3 minutes later) should be voided. The agent must correctly infer which is the duplicate.

```json
{
  "id": "stress_tc02",
  "exception_type": "duplicate_shipment",
  "order_id": "ORD-2200",
  "tracking_numbers": ["1Z999AA10123000010", "1Z999AA10123000011"],
  "carrier": "UPS",
  "both_shipped": false,
  "first_label_created": "2026-05-26T08:00:00Z",
  "second_label_created": "2026-05-26T08:03:47Z",
  "root_cause_hint": "double_click_submit",
  "customer_email": "stress.user02@example.com",
  "order_value_usd": 75.00
}
```

**Expected tool calls:**
- `void_label` with `tracking_number: "1Z999AA10123000011"` (the second/later label)
- `notify_customer` with template `outage_suppression` or similar confirming primary shipment is active

**Prohibited tool calls:**
- `void_label` on the **first** tracking number `"1Z999AA10123000010"`

**Grading criteria:**
- [ ] `void_label` called with the second tracking number
- [ ] `notify_customer` called (customer needs confirmation)
- [ ] Resolution explains which label was voided and why

---

### TC-03 · Return Not Received — Refund Must Be Withheld

**Why it's a stress test:** The customer may expect a refund, but the system prompt says "do not issue refund yet" for `return_not_received`. The agent must call `contact_carrier` + `escalate` and explicitly hold back from calling `refund`.

```json
{
  "id": "stress_tc03",
  "exception_type": "return_not_received",
  "order_id": "ORD-3310",
  "return_tracking_number": "9261290100830413958222",
  "carrier": "USPS",
  "return_label_created": "2026-05-10T00:00:00Z",
  "label_first_scan": "2026-05-11T09:00:00Z",
  "expected_warehouse_arrival": "2026-05-14",
  "current_date": "2026-05-26",
  "last_known_location": "USPS Regional Hub, Memphis, TN",
  "refund_status": "pending",
  "customer_email": "stress.user03@example.com",
  "return_value_usd": 215.00
}
```

**Expected tool calls:**
- `contact_carrier` (investigate the in-transit return)
- `escalate` (return is 12 days overdue)
- `notify_customer` with `delay_notice` or equivalent

**Prohibited tool calls:**
- `refund` (must not issue refund without confirmed receipt)

**Grading criteria:**
- [ ] `contact_carrier` called with the return tracking number
- [ ] `escalate` called (12 days overdue justifies escalation)
- [ ] `refund` is **absent** from audit trail
- [ ] Resolution explicitly states refund is on hold pending investigation

---

## Category 2 — Multi-Step Chain Completeness

These cases require 3+ tools in a specific order. Test whether the agent completes the full chain rather than stopping after the first tool.

---

### TC-04 · Damaged High-Value Package With Photo Evidence

**Why it's a stress test:** The system prompt says "file_claim (damage, attach evidence_urls if present), then reschedule or refund based on order value." At $589 the order is high-value — both a claim and a reschedule (replacement) should be triggered, and photos must be attached.

```json
{
  "id": "stress_tc04",
  "exception_type": "damaged_package",
  "order_id": "ORD-4400",
  "tracking_number": "1Z999AA10199000004",
  "carrier": "UPS",
  "damage_reported_at": "2026-05-26T07:45:00Z",
  "damage_description": "Sofa leg snapped in transit, packaging intact but item unusable",
  "photo_urls": [
    "https://storage.example.com/claims/ORD-4400/img1.jpg",
    "https://storage.example.com/claims/ORD-4400/img2.jpg",
    "https://storage.example.com/claims/ORD-4400/img3.jpg"
  ],
  "customer_email": "stress.user04@example.com",
  "order_value_usd": 589.00,
  "item_sku": "FURN-SOFA-LEG-PRO"
}
```

**Expected tool calls (in order):**
1. `file_claim` with `claim_type: "damage"`, `evidence_urls` containing all 3 photo URLs
2. `reschedule` (high-value item warrants replacement, not just refund)
3. `notify_customer` with `replacement_shipped` or `claim_opened` template

**Grading criteria:**
- [ ] `file_claim` called with `claim_type: "damage"`
- [ ] All 3 `evidence_urls` passed to `file_claim`
- [ ] `reschedule` or `refund` called (at least one)
- [ ] `notify_customer` called
- [ ] Full 3-step chain completed (no early stop)

---

### TC-05 · Address Not Found — Second Delivery Attempt (Escalation Threshold)

**Why it's a stress test:** The system prompt says "escalate if >1 delivery attempt." This case has exactly 2 attempts — the agent must escalate, not just notify.

```json
{
  "id": "stress_tc05",
  "exception_type": "address_not_found",
  "order_id": "ORD-5501",
  "tracking_number": "9400111899223397225000",
  "carrier": "USPS",
  "destination_address": "88 Oak Lane, Apt 4B, Nowhere, ZZ 99999",
  "delivery_attempts": 2,
  "last_attempt": "2026-05-26T10:00:00Z",
  "previous_attempt": "2026-05-25T09:30:00Z",
  "customer_email": "stress.user05@example.com",
  "order_value_usd": 120.00
}
```

**Expected tool calls:**
- `notify_customer` with `address_correction_request`
- `escalate` (because attempts > 1)

**Grading criteria:**
- [ ] `escalate` called (2 attempts exceeds threshold)
- [ ] `notify_customer` called for address correction
- [ ] Resolution acknowledges multiple failed attempts

---

### TC-06 · Customs Hold — Extended Hold (8 Days) Approaching Escalation

**Why it's a stress test:** The system prompt says "escalate if held beyond 10 days." This case is 8 days in — the agent should escalate now (proactively) and notify, not wait for 10 days.

```json
{
  "id": "stress_tc06",
  "exception_type": "customs_hold",
  "order_id": "ORD-6600",
  "tracking_number": "LY987654321DE",
  "carrier": "DHL",
  "origin_country": "DE",
  "destination_country": "US",
  "hold_reason": "restricted_item_review",
  "held_since": "2026-05-18T08:00:00Z",
  "current_date": "2026-05-26T00:00:00Z",
  "customs_office": "JFK, New York, NY",
  "customer_email": "stress.user06@example.com",
  "order_value_usd": 450.00,
  "hs_code": "9503.00"
}
```

**Expected tool calls:**
- `escalate` with `severity` of at least `"high"` (8 days, restricted item)
- `notify_customer` with `delay_notice`

**Grading criteria:**
- [ ] `escalate` called (8 days is near the 10-day threshold)
- [ ] `severity` is `"high"` or `"critical"` (not `"low"` or `"medium"`)
- [ ] `notify_customer` called
- [ ] Resolution mentions customs hold duration and escalation reason

---

## Category 3 — Conflicting or Ambiguous Signals

These cases present contradictory evidence the agent must reason through.

---

### TC-07 · Delivery Dispute — GPS Coordinates Far From Delivery Address

**Why it's a stress test:** The carrier says "delivered at front door" but GPS coordinates are 8 km away from the customer's address. The agent should recognize this as strong evidence of a mis-delivery and take aggressive action.

```json
{
  "id": "stress_tc07",
  "exception_type": "delivery_dispute",
  "order_id": "ORD-7700",
  "tracking_number": "JD014600004293801599",
  "carrier": "FedEx",
  "marked_delivered_at": "2026-05-25T15:30:00Z",
  "delivery_location": "Front Door",
  "customer_address": "100 Main St, Boston, MA 02101",
  "gps_coordinates": { "lat": 42.2529, "lng": -71.0023 },
  "customer_reported_missing": true,
  "customer_email": "stress.user07@example.com",
  "order_value_usd": 899.00,
  "item_sku": "ELEC-LAPTOP-PRO"
}
```

**GPS note:** 42.2529, -71.0023 is approximately 8 km south of 42.3601, -71.0589 (downtown Boston) — a clear mis-delivery.

**Expected tool calls:**
- `file_claim` with `claim_type: "dispute"` or `"loss"`
- `escalate` with high/critical severity (GPS mismatch + high value)
- `notify_customer`

**Grading criteria:**
- [ ] `file_claim` called (GPS mismatch is strong evidence)
- [ ] `escalate` called with `severity: "high"` or `"critical"` (not low/medium)
- [ ] `notify_customer` called
- [ ] Resolution text acknowledges GPS discrepancy

---

### TC-08 · Delayed Shipment — Last Scan is 72+ Hours Old (Presumed Lost)

**Why it's a stress test:** A typical delay is 1–2 days; 72+ hours with no scan suggests the package may be lost. The agent must still follow `delayed_shipment` procedure but the resolution reasoning should reflect urgency.

```json
{
  "id": "stress_tc08",
  "exception_type": "delayed_shipment",
  "order_id": "ORD-8801",
  "tracking_number": "1Z999AA10123000088",
  "carrier": "UPS",
  "origin": "Seattle, WA",
  "destination": "Miami, FL",
  "promised_delivery": "2026-05-21",
  "current_date": "2026-05-26",
  "last_scan": {
    "location": "Louisville, KY Hub",
    "timestamp": "2026-05-22T23:00:00Z",
    "status": "Departed Facility"
  },
  "customer_email": "stress.user08@example.com",
  "order_value_usd": 310.00
}
```

**Expected tool calls:**
- `contact_carrier` (check status)
- `notify_customer` with `delay_notice`
- `escalate` (5 days past SLA with 72h scan gap warrants escalation)

**Grading criteria:**
- [ ] `contact_carrier` called
- [ ] `notify_customer` called
- [ ] `escalate` called given the severity of the delay
- [ ] Resolution acknowledges 72h scan gap and possibility of lost package

---

### TC-09 · Damaged Package — Low-Value Item (Refund Over Reschedule)

**Why it's a stress test:** System prompt says "reschedule or refund based on order value." At $18.50, a replacement shipment costs nearly as much as the item — the agent should issue a refund instead of rescheduling.

```json
{
  "id": "stress_tc09",
  "exception_type": "damaged_package",
  "order_id": "ORD-9901",
  "tracking_number": "1Z999AA10123000099",
  "carrier": "UPS",
  "damage_reported_at": "2026-05-26T11:00:00Z",
  "damage_description": "Small ceramic mug cracked, pieces in bag",
  "photo_urls": ["https://storage.example.com/claims/ORD-9901/mug.jpg"],
  "customer_email": "stress.user09@example.com",
  "order_value_usd": 18.50,
  "item_sku": "HOME-MUG-CERAMIC-SM"
}
```

**Expected tool calls:**
- `file_claim` with `claim_type: "damage"`, photo URL attached
- `refund` (low order value — reschedule not economical)
- `notify_customer` with `refund_initiated`

**Prohibited tool calls:**
- `reschedule` (economically unjustified at $18.50)

**Grading criteria:**
- [ ] `file_claim` called with photo URL
- [ ] `refund` called with `amount_usd: 18.50`
- [ ] `notify_customer` called
- [ ] `reschedule` is **absent** (or if present, resolution justifies it)

---

### TC-10 · Delivery Dispute — Low-Value Item, No GPS Data

**Why it's a stress test:** Disputes typically warrant claim + escalate, but with $12 order value and no GPS evidence, the agent should still follow protocol but severity assessment matters.

```json
{
  "id": "stress_tc10",
  "exception_type": "delivery_dispute",
  "order_id": "ORD-1011",
  "tracking_number": "9400111899223397221010",
  "carrier": "USPS",
  "marked_delivered_at": "2026-05-25T14:00:00Z",
  "delivery_location": "Mailbox",
  "customer_reported_missing": true,
  "customer_email": "stress.user10@example.com",
  "order_value_usd": 12.00
}
```

**Expected tool calls:**
- `file_claim` with `claim_type: "dispute"` or `"missing"`
- `escalate` and/or `notify_customer`

**Grading criteria:**
- [ ] `file_claim` called (protocol requires it regardless of value)
- [ ] `notify_customer` called to acknowledge dispute
- [ ] Severity is proportionate (not `"critical"` for a $12 item)

---

## Category 4 — Edge Cases in Business Logic

---

### TC-11 · Duplicate Shipment — Both Labels Already Picked Up by Carrier

**Why it's a stress test:** If `both_shipped: true`, voiding one label may not be possible (already in transit). The agent must handle this differently — escalating instead of calling `void_label` blindly.

```json
{
  "id": "stress_tc11",
  "exception_type": "duplicate_shipment",
  "order_id": "ORD-1100",
  "tracking_numbers": ["1Z999AA10123001100", "1Z999AA10123001101"],
  "carrier": "UPS",
  "both_shipped": true,
  "first_label_created": "2026-05-25T08:00:00Z",
  "second_label_created": "2026-05-25T08:04:00Z",
  "root_cause_hint": "api_retry_on_timeout",
  "customer_email": "stress.user11@example.com",
  "order_value_usd": 240.00
}
```

**Expected tool calls:**
- `void_label` (attempt on the duplicate)
- `notify_customer` (confirm which shipment to expect)
- Possibly `escalate` if void is not feasible

**Grading criteria:**
- [ ] `void_label` called on the second tracking number
- [ ] `notify_customer` called to prevent customer confusion about two deliveries
- [ ] Resolution acknowledges the complication of both being in transit

---

### TC-12 · Address Not Found — First Attempt, Customer Email Missing

**Why it's a stress test:** The `customer_email` field is absent. The agent cannot call `notify_customer` but must still process the case and communicate limitations.

```json
{
  "id": "stress_tc12",
  "exception_type": "address_not_found",
  "order_id": "ORD-1200",
  "tracking_number": "9400111899223397221200",
  "carrier": "USPS",
  "destination_address": "555 Unknown Blvd, Ghosttown, ZZ 00001",
  "delivery_attempts": 1,
  "last_attempt": "2026-05-26T09:00:00Z",
  "order_value_usd": 99.00
}
```

**Expected behavior:**
- Agent should not hallucinate a customer email
- Should escalate for manual lookup and outreach

**Grading criteria:**
- [ ] `escalate` called (manual intervention needed to reach customer)
- [ ] `notify_customer` NOT called with a fabricated email
- [ ] Resolution mentions missing contact info as a blocker

---

### TC-13 · Customs Hold — Multiple Hold Reasons Stacked

**Why it's a stress test:** Multiple customs blockers simultaneously. Agent must identify the most urgent, escalate, and give a coherent resolution.

```json
{
  "id": "stress_tc13",
  "exception_type": "customs_hold",
  "order_id": "ORD-1300",
  "tracking_number": "LY555666777CN",
  "carrier": "DHL",
  "origin_country": "CN",
  "destination_country": "US",
  "hold_reasons": [
    "missing_commercial_invoice",
    "restricted_item_pending_review",
    "duties_unpaid"
  ],
  "held_since": "2026-05-23T08:00:00Z",
  "current_date": "2026-05-26T00:00:00Z",
  "customs_office": "Los Angeles, CA",
  "customer_email": "stress.user13@example.com",
  "order_value_usd": 1200.00,
  "hs_code": "9503.00"
}
```

**Expected tool calls:**
- `escalate` with `severity: "high"` or `"critical"` (multiple blockers, high value)
- `notify_customer` with `delay_notice`

**Grading criteria:**
- [ ] `escalate` called with at least `"high"` severity
- [ ] `notify_customer` called
- [ ] Resolution addresses all three hold reasons or prioritizes the most urgent
- [ ] High order value ($1200) reflected in urgency

---

### TC-14 · Carrier API Failure — Single Carrier, Orders Already Past SLA

**Why it's a stress test:** The API failure prevents tracking updates, but the affected orders were already past their delivery SLA before the outage. The agent must escalate critically and still suppress customer notifications (per protocol) even though orders are late.

```json
{
  "id": "stress_tc14",
  "exception_type": "carrier_api_failure",
  "carrier": "FedEx",
  "affected_order_count": 7,
  "affected_order_ids": ["ORD-1401", "ORD-1402", "ORD-1403"],
  "error_code": 503,
  "error_message": "Upstream timeout",
  "first_failure_at": "2026-05-26T04:00:00Z",
  "consecutive_failures": 25,
  "retry_interval_seconds": 60,
  "note": "All affected orders were promised delivery by 2026-05-24 — already 2 days past SLA"
}
```

**Expected tool calls:**
- `escalate` with `severity: "critical"`

**Prohibited tool calls:**
- `notify_customer` (suppression rule during outage)

**Grading criteria:**
- [ ] `escalate` called with `severity: "critical"` (25 consecutive failures)
- [ ] `notify_customer` **absent** (suppression must hold even for past-SLA orders)
- [ ] Resolution plan includes resuming customer notifications after API recovers

---

## Category 5 — Reasoning Under Pressure (Thinking Mode Cases)

These case types (`delivery_dispute`, `customs_hold`, `damaged_package`) activate `enable_thinking: true` in the agent. These tests verify deeper reasoning is applied correctly.

---

### TC-15 · Delivery Dispute — Contradictory POD Photo and Customer Testimony

**Why it's a stress test:** Carrier claims a POD photo exists but it shows a different door color than the customer's address. This requires multi-step inference to decide whether to file claim or escalate.

```json
{
  "id": "stress_tc15",
  "exception_type": "delivery_dispute",
  "order_id": "ORD-1500",
  "tracking_number": "JD014600004293801515",
  "carrier": "FedEx",
  "marked_delivered_at": "2026-05-25T13:00:00Z",
  "delivery_location": "Front Door",
  "pod_photo_url": "https://storage.example.com/pod/ORD-1500/photo.jpg",
  "pod_photo_note": "Photo shows red door; customer address has a blue door per Street View",
  "customer_reported_missing": true,
  "customer_email": "stress.user15@example.com",
  "order_value_usd": 650.00
}
```

**Expected tool calls:**
- `file_claim` with `claim_type: "dispute"`, attach `pod_photo_url` as evidence
- `escalate` with high severity (clear mis-delivery evidence)
- `notify_customer`

**Grading criteria:**
- [ ] `file_claim` called with `claim_type: "dispute"`
- [ ] `evidence_urls` includes the POD photo URL
- [ ] `escalate` called with `severity: "high"` or `"critical"`
- [ ] `notify_customer` called
- [ ] Resolution text references the door color discrepancy as the key evidence

---

### TC-16 · Damaged Package — Damage Reported 15 Days After Delivery

**Why it's a stress test:** Delayed damage reports may fall outside carrier claim windows. The agent must still file the claim but should note the late reporting risk.

```json
{
  "id": "stress_tc16",
  "exception_type": "damaged_package",
  "order_id": "ORD-1600",
  "tracking_number": "1Z999AA10123001600",
  "carrier": "UPS",
  "delivered_at": "2026-05-11T14:00:00Z",
  "damage_reported_at": "2026-05-26T10:00:00Z",
  "damage_description": "Concealed damage found after unpacking — leg joint cracked internally",
  "photo_urls": ["https://storage.example.com/claims/ORD-1600/concealed.jpg"],
  "customer_email": "stress.user16@example.com",
  "order_value_usd": 340.00
}
```

**Expected tool calls:**
- `file_claim` with `claim_type: "damage"` and photo evidence
- `escalate` (claim may be rejected due to 15-day gap — ops review needed)
- `notify_customer` with claim_opened template

**Grading criteria:**
- [ ] `file_claim` called despite late reporting
- [ ] `escalate` called (carrier may reject; manual review warranted)
- [ ] Resolution text acknowledges reporting delay and claim risk
- [ ] `notify_customer` called

---

## Category 6 — Idempotency and State Consistency

---

### TC-17 · Re-resolving an Already-Resolved Case

**Why it's a stress test:** The Durable Object returns `{ idempotent: true }` for already-resolved cases. The API endpoint `POST /case/:id/resolve` should handle this gracefully.

**Test procedure:**
1. Submit case with `id: "stress_tc01"` (run TC-01)
2. Wait for resolution
3. POST to `/case/stress_tc01/resolve` again

**Expected behavior:**
- Response contains `{ idempotent: true, state: { status: "resolved", ... } }`
- Agent loop is **not** re-executed (no new audit entries added)
- Token usage remains unchanged from first resolution

**Grading criteria:**
- [ ] Second resolve returns `idempotent: true`
- [ ] Audit trail length unchanged
- [ ] No second LLM call made

---

### TC-18 · Submit Same Case ID Twice Concurrently

**Why it's a stress test:** Two simultaneous `POST /case` requests with the same case ID should result in one case created and one returning `already_exists`.

**Test procedure:**
Send these two requests as close to simultaneously as possible:
```bash
curl -X POST http://localhost:8787/case -d '{"id":"stress_concurrent","exception_type":"delayed_shipment","order_id":"ORD-CONC","tracking_number":"1ZCONCTEST00001","carrier":"UPS","customer_email":"concurrent@example.com","order_value_usd":100}' -H "Content-Type: application/json" &
curl -X POST http://localhost:8787/case -d '{"id":"stress_concurrent","exception_type":"delayed_shipment","order_id":"ORD-CONC","tracking_number":"1ZCONCTEST00001","carrier":"UPS","customer_email":"concurrent@example.com","order_value_usd":100}' -H "Content-Type: application/json" &
```

**Expected behavior:**
- One response: `{ caseId: "stress_concurrent", status: "processing" }` (HTTP 202)
- Other response: `{ message: "Case already exists", ... }` (HTTP 200)
- Final case state has exactly one resolution

**Grading criteria:**
- [ ] Durable Object idempotency prevents double processing
- [ ] Only one audit trail created
- [ ] No duplicate tool calls in audit

---

## Category 7 — Iteration Limit Stress

---

### TC-19 · Pathologically Complex Case Requiring Many Tool Calls

**Why it's a stress test:** This case combines signals from multiple exception types, requiring the agent to make several sequential tool calls. The 8-iteration cap may cut it short.

```json
{
  "id": "stress_tc19",
  "exception_type": "damaged_package",
  "order_id": "ORD-1900",
  "tracking_number": "1Z999AA10123001900",
  "carrier": "UPS",
  "damage_reported_at": "2026-05-26T08:00:00Z",
  "damage_description": "Item completely destroyed. Original box shows signs of re-tape (possible tampering). GPS mismatch on delivery scan.",
  "photo_urls": [
    "https://storage.example.com/claims/ORD-1900/front.jpg",
    "https://storage.example.com/claims/ORD-1900/side.jpg",
    "https://storage.example.com/claims/ORD-1900/label.jpg",
    "https://storage.example.com/claims/ORD-1900/interior.jpg"
  ],
  "customer_email": "stress.user19@example.com",
  "order_value_usd": 1499.00,
  "item_sku": "ELEC-CAMERA-DSLR",
  "additional_context": "Customer is a repeat buyer with 5-year history. Previous claim filed 18 months ago for different order."
}
```

**Expected tool calls:**
1. `file_claim` with `claim_type: "damage"`, all 4 photo URLs
2. `escalate` with `severity: "critical"` (tampering + high value)
3. `reschedule` (high-value item needs replacement)
4. `notify_customer` with appropriate template

**Grading criteria:**
- [ ] All 4 steps completed within 8 iterations
- [ ] `evidence_urls` contains all 4 photo URLs
- [ ] `severity: "critical"` used for escalation (tampering suspected)
- [ ] `reschedule` called (not just refund at $1499)
- [ ] Resolution is not "Unable to resolve within iteration limit"

---

### TC-20 · Carrier API Failure During Mass Outage With Context Overflow Risk

**Why it's a stress test:** A large `affected_order_ids` array tests whether the agent handles a data-heavy input without losing track of the core task.

```json
{
  "id": "stress_tc20",
  "exception_type": "carrier_api_failure",
  "carrier": "USPS",
  "affected_order_count": 250,
  "affected_order_ids": [
    "ORD-2001", "ORD-2002", "ORD-2003", "ORD-2004", "ORD-2005",
    "ORD-2006", "ORD-2007", "ORD-2008", "ORD-2009", "ORD-2010",
    "ORD-2011", "ORD-2012", "ORD-2013", "ORD-2014", "ORD-2015",
    "ORD-2016", "ORD-2017", "ORD-2018", "ORD-2019", "ORD-2020"
  ],
  "error_code": 429,
  "error_message": "Rate limit exceeded",
  "first_failure_at": "2026-05-26T00:00:00Z",
  "consecutive_failures": 48,
  "retry_interval_seconds": 600
}
```

**Expected tool calls:**
- `escalate` with `severity: "critical"` (250 affected orders, 48 consecutive failures)

**Prohibited tool calls:**
- `notify_customer`

**Grading criteria:**
- [ ] Agent processes large payload without truncating or ignoring fields
- [ ] `escalate` called with `severity: "critical"`
- [ ] `notify_customer` **absent**
- [ ] `affected_order_count: 250` referenced in escalation reason

---

## Scoring Summary

| Test | Category | Key Risk Probed |
|------|----------|----------------|
| TC-01 | Tool Selection | Customer notification suppression during outage |
| TC-02 | Tool Selection | Correct duplicate label identification |
| TC-03 | Tool Selection | Refund withholding on return_not_received |
| TC-04 | Chain Completeness | All 3 steps + photo evidence attachment |
| TC-05 | Chain Completeness | Escalation threshold at delivery_attempts > 1 |
| TC-06 | Chain Completeness | Proactive escalation near 10-day customs limit |
| TC-07 | Conflicting Signals | GPS mismatch → aggressive claim + escalation |
| TC-08 | Conflicting Signals | 72h scan gap → presumed lost reasoning |
| TC-09 | Business Logic | Low-value damage → refund not reschedule |
| TC-10 | Business Logic | Low-value dispute still requires claim |
| TC-11 | Edge Case | Both labels in transit → void attempt + escalate |
| TC-12 | Edge Case | Missing customer email → no hallucinated contact |
| TC-13 | Edge Case | Multiple customs blockers handled coherently |
| TC-14 | Reasoning | Suppression holds even for past-SLA orders |
| TC-15 | Thinking Mode | POD photo discrepancy → evidence-based claim |
| TC-16 | Thinking Mode | Late damage report → claim despite risk |
| TC-17 | Idempotency | Already-resolved case not re-processed |
| TC-18 | Idempotency | Concurrent submits → single case |
| TC-19 | Iteration Limit | Complex 4-tool chain within 8 iterations |
| TC-20 | Iteration Limit | Large payload doesn't confuse core task |
