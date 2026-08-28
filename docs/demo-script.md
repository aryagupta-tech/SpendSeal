# SpendSeal five-minute pitch

## 0:00–0:35 — Problem

“AI agents can understand what we want to buy, but understanding is not payment authority. If a price changes, a product is substituted, or the same action is replayed, the model should not be the final security boundary.”

Show the SpendSeal dashboard and the pipeline card.

## 0:35–1:40 — Successful agentic purchase

In ChatGPT, with the SpendSeal MCP connection enabled, send:

> Buy NovaDesk Pro Annual only if it is refundable for at least 7 days, costs no more than ₹1,100, and the price does not change. Make the permission expire in 10 minutes.

Let ChatGPT list the catalog and create the PurchasePermit. Point out the structured constraints and open the approval URL. Say: “There is no MCP approval tool. The model cannot grant itself authority, and possession of this link alone is not approval.”

If this is the first run, enroll the demo buyer passkey. Approve with the passkey and point out that the bearer token disappears from the URL. Clarify that this is device-bound authenticator proof, not KYC. Return to ChatGPT, ask it to continue, and complete Razorpay Test Mode checkout.

## 1:40–2:45 — Post-intent price bait-and-switch

Create a second equivalent PurchasePermit and approve it. Before preparing checkout, use **Manipulate price** on the merchant dashboard. NovaDesk's authoritative server price changes from ₹999 to ₹1,299.

Ask ChatGPT to continue. SpendSeal returns `PRICE_CHANGED` and `BUDGET_EXCEEDED`; no Razorpay order is created.

## 2:45–3:30 — Duplicate prevention

Ask ChatGPT to prepare checkout again for the already-paid first PurchasePermit. Show `REPLAY_DETECTED` and the unchanged provider-order count.

## 3:30–4:25 — Evidence

Open the audit explorer. Select `PASSKEY_VERIFIED`, `POLICY_ALLOWED`, `PAYMENT_VERIFIED`, `POLICY_DENIED`, and `REPLAY_BLOCKED`. Show catalog version/hash evidence, the previous hash, current hash, and green **SHA-256 chain verified** state. Say explicitly: “Tamper-evident local chain—not blockchain or an externally anchored ledger.”

## 4:25–5:00 — Architecture and close

Explain the separation:

- ChatGPT interprets natural language.
- PurchasePermit records exact permission.
- A passkey proves device-bound human approval.
- Deterministic policy gates money actions and records the exact merchant catalog evidence used.
- Razorpay handles Test Mode checkout.
- The ledger makes every outcome explainable.

Close with:

> ChatGPT interprets. A passkey approves. SpendSeal enforces. Razorpay moves the money.

## Failure fallback

If ChatGPT or the tunnel is unavailable, use **Standalone fallback → Create bounded mandate** on the dashboard. State clearly that it is a structured deterministic fallback, not a replacement LLM.
