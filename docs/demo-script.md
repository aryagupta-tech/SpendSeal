# SpendSeal private five-minute demo runbook

For Arya's Razorpay Buildathon Track 01 recording. This file contains no credentials. Keep it beside the recording window, not on screen.

## The product in one sentence

SpendSeal lets a buyer agent and a merchant policy agent negotiate inside two private price limits, seals the accepted deal into one buyer-approved PurchasePermit, and executes exactly one Razorpay Test Mode payment.

## The proof the demo must show

- Public Shopify price: INR 49.95.
- Buyer's hard maximum: INR 45.
- Merchant's encrypted private minimum: INR 42.
- Buyer offers: INR 40, INR 43, then INR 45.
- Expected merchant counters: about INR 47.97, then INR 45.18.
- Accepted deal: INR 45.
- Buyer savings: INR 4.95.
- Payment: Razorpay Test Mode only.
- Failure: replaying the paid permit produces `REPLAY_DETECTED` and no second order.

The exact counter is calculated from the current Shopify price. If Shopify data changes slightly, continue with the same increasing offers and describe the counter as deterministic instead of promising an exact number.

## Before recording

Do these checks slowly before you press Record.

1. Open `https://spendseal.vercel.app` and sign in with the production passkey.
2. Select **SpendSeal Test Store**.
3. Confirm Shopify catalog says **Connected**.
4. Confirm Razorpay says **Test Mode connected**.
5. Confirm the webhook is configured and the last rehearsed Test payment is visible.
6. Open **Merchant AI Sales Closer**.
7. Confirm **Selling Plans Ski Wax - Special Selling Plans Ski Wax** has negotiation enabled and the private minimum is INR 42.
8. Confirm the product's current public price is INR 49.95. If the page shows a rounded stale value, hard-refresh once.
9. In ChatGPT, confirm the **SpendSeal Dealmaker** connection is enabled. The current demo endpoint is `https://spendseal.vercel.app/mcp-v3`.
10. Keep the existing successful deal audit and PurchasePermit audit open in background tabs. These are your safest network-failure backup.
11. Close tabs that contain Shopify tokens, Razorpay keys, webhook secrets, database URLs or environment variables.
12. Turn off desktop notifications. Zoom the browser to a readable level.
13. Use only Razorpay Test Mode. Never enter a real card, UPI PIN or bank credential in the recording.

If an older deal is still active, continue that deal. Do not start another one. If an old approval link has already been opened, return to its original tab or the token-free PurchasePermit page; do not reopen the one-time link.

## Five-minute recording

### 0:00-0:35 - The lost sale

What you do:

1. Show the Merchant AI Sales Channel.
2. Show the Shopify product at INR 49.95.
3. Briefly point to the negotiation analytics cards.

What you say:

> AI agents can search a catalog and click checkout, but that does not solve a merchant's hardest conversion problem. Here, the product costs INR 49.95 and the buyer refuses to spend more than INR 45. An ordinary checkout loses the sale. The merchant could still profit below the public price, but publishing its true minimum would weaken pricing for every buyer. SpendSeal creates a private, bounded negotiation between these two principals.

Expected screen:

- Product public price is visible.
- Do not reveal the private minimum yet.

### 0:35-1:05 - Give the merchant private authority

What you do:

1. Open **Merchant AI Sales Closer**.
2. Select the ski-wax product.
3. Show that negotiation is enabled with a private minimum of INR 42.
4. Do not edit or save it during the recording.

What you say:

> The merchant gives SpendSeal one exact minimum: INR 42. This value is encrypted with AES-256-GCM, attached to an immutable policy version and available only to the merchant control plane. ChatGPT, the buyer, MCP responses, analytics, logs and buyer-facing audit events never receive this floor. The merchant policy agent can negotiate against it without disclosing it.

Expected screen:

- Negotiation is enabled.
- The product and merchant minimum are visible only in the merchant view.

### 1:05-2:05 - Let the agents make a deal

What you do:

1. Switch to ChatGPT.
2. Paste Prompt 1 below.
3. After the first counter, paste Prompt 2.
4. After the second counter, paste Prompt 3.

Prompt 1:

> Use SpendSeal Dealmaker. Open SpendSeal Test Store and find Selling Plans Ski Wax. My hard maximum is INR 45. Start a price negotiation with INR 40. Do not create an ordinary PurchasePermit.

Prompt 2:

> Submit INR 43 as my second offer on the same deal. Keep my hard maximum at INR 45.

Prompt 3:

> Submit INR 45 as my third and final offer on the same deal. Do not exceed my INR 45 hard maximum.

What you say while the tools run:

> ChatGPT is the buyer agent, but its authority is fixed at INR 45. It cannot silently increase that ceiling. SpendSeal's merchant agent follows a deterministic three-round policy: buyer offers can only rise and merchant counters can only fall. The first offer is INR 40. The merchant counters. The buyer moves to INR 43. The merchant moves closer again. On the final INR 45 offer, both private constraints are satisfied, so the deal is accepted. Neither private boundary was exposed to the other side.

Expected screen:

- First buyer offer: INR 40.
- First counter: approximately INR 47.97.
- Second buyer offer: INR 43.
- Second counter: approximately INR 45.18.
- Final buyer offer and accepted price: INR 45.
- One offer remaining becomes zero.

If ChatGPT says an active deal already exists, tell it:

> Resume the existing active deal for this product. Do not start a new deal and do not change my original ceiling.

### 2:05-2:45 - Seal the deal and approve it

What you do:

1. Paste Prompt 4.
2. Open the approval link once.
3. Check public price, negotiated price, savings, maximum and expiry.
4. Click the passkey approval button.
5. Complete the device passkey prompt.

Prompt 4:

> Create the negotiated PurchasePermit for this accepted deal and give me its approval link. Do not create a new negotiation.

What you say:

> Acceptance is not payment authority. SpendSeal now seals the agreement into a PurchasePermit bound to this buyer, merchant, Shopify product revision, public price, negotiated price, buyer maximum, merchant policy version, accepted-offer hash and expiry. ChatGPT has no approval tool. Only the buyer can approve with a passkey. The buyer can see the public price of INR 49.95, the INR 45 negotiated price and INR 4.95 savings before authorizing anything.

Expected screen:

- Public price: INR 49.95.
- Negotiated price: INR 45.
- Savings: INR 4.95.
- Maximum: INR 45.
- Passkey approval succeeds.

### Approval link safety

- The approval URL is single-use.
- Click it once only.
- If it says the link was already exchanged, return to the original approval tab or open the PurchasePermit from the signed-in dashboard.

### 2:45-3:30 - Execute one Razorpay Test Mode payment

What you do:

1. Return to ChatGPT.
2. Paste Prompt 5.
3. Open the Razorpay Test checkout.
4. Complete the same Test Mode payment method used in rehearsal.
5. Wait for **Payment verified**.

Prompt 5:

> Continue the approved negotiated PurchasePermit. Revalidate it and prepare the Razorpay Test Mode checkout. Do not create another deal or permit.

What you say:

> Approval still does not mean blind execution. SpendSeal re-fetches the exact Shopify variant, checks its revision, public price and availability, decrypts the current merchant authority, verifies the same policy version, checks the buyer ceiling and atomically claims one payment attempt. Only then does it create a Razorpay Test Mode order for INR 45, the negotiated amount rather than the public amount. Razorpay handles the test checkout, and SpendSeal verifies the signed payment evidence.

Expected screen:

- Policy check is allowed.
- Razorpay order amount is INR 45.
- Final state is payment verified.

If the webhook takes a few seconds, wait quietly and refresh the PurchasePermit once. Do not retry the payment.

### 3:30-4:05 - Prove merchant value

What you do:

1. Return to the merchant dashboard.
2. Refresh once.
3. Point to deals accepted, deal-to-payment conversion, constraint-recovered Test orders and constraint-recovered Test Mode GMV.

What you say:

> The dashboard now shows a verified negotiated conversion. This is constraint-recovered Test Mode GMV: INR 45 that could not have converted at the public INR 49.95 price because the buyer's original ceiling was lower. SpendSeal is not claiming real revenue in this demonstration. It is measuring a complete Razorpay Test Mode sales funnel from negotiation to verified payment.

Expected screen:

- One accepted deal.
- One verified Test payment.
- INR 45 constraint-recovered Test Mode GMV.

### 4:05-4:35 - Show explainable evidence and one safe failure

What you do:

1. Open the deal audit.
2. Show the offers, counters and acceptance.
3. Open the PurchasePermit audit.
4. Show passkey approval, policy allowed, order created and payment verified.
5. Ask ChatGPT to prepare checkout again for the paid permit.

Replay prompt:

> Try to prepare checkout again for the same paid PurchasePermit. Do not create a new permit.

What you say:

> Every decision is explainable in two SHA-256-linked, append-only audit chains. The deal chain shows visible offers and counters, but never the merchant's private minimum. The PurchasePermit chain shows approval, final revalidation and Razorpay verification. Replaying the paid permit returns REPLAY_DETECTED. No second order is created. This is tamper-evident evidence, not a blockchain claim.

Expected screen:

- Both hash chains verify as valid.
- Replay returns `REPLAY_DETECTED`.
- Razorpay order count does not increase.

### 4:35-5:00 - Close with the difference

What you do:

1. Return to the dashboard overview.
2. Keep the recovered-GMV card visible.

What you say:

> ChatGPT is an excellent operator, but it should not be the financial authority for both sides of a transaction. It cannot safely hold a merchant's secret floor, independently prove buyer approval, revalidate Shopify evidence after approval, guarantee one payment claim and produce a merchant-controlled decision trail by itself. SpendSeal is the bounded control plane underneath the agent. The buyer controls the ceiling. The merchant controls the floor. SpendSeal creates and verifies the agreement. Razorpay executes exactly once. That is how SpendSeal turns a price-sensitive AI shopper into a paid Test Mode order without giving the AI unrestricted financial authority.

Final line:

> Buyer and merchant agents create the deal. SpendSeal seals it. Razorpay executes it.

## If the live demo breaks

Use the first fallback that works. Do not improvise with real credentials.

### Fallback A - ChatGPT connection is slow

1. Show the already completed deal audit.
2. Walk through INR 40, INR 43 and INR 45.
3. Show the accepted PurchasePermit and payment-verified event.
4. Say: “The live operator connection is unavailable, so I am showing the immutable evidence from the same rehearsed Test Mode path.”

### Fallback B - Razorpay Test checkout or network is unavailable

1. Do not switch adapters in the middle of the main merchant flow.
2. Open the already verified Razorpay PurchasePermit audit from rehearsal.
3. Show the Razorpay Test order ID, payment verification and INR 45 recovered Test Mode GMV.
4. Explain that the current provider page is unavailable, but the signed prior test evidence is preserved.

### Fallback C - Complete provider outage

Use a separately prepared deterministic mock permit only if both live evidence paths are unavailable.

Say clearly:

> This backup uses SpendSeal's deterministic mock adapter. It proves policy, passkey, single-use execution and audit behavior, but it is not Razorpay-verified and it does not count as recovered Test Mode GMV.

Never present mock evidence as a Razorpay payment.

## Thirty-second emergency pitch

> SpendSeal is a bounded AI dealmaker for Razorpay Track 01. A buyer gives ChatGPT a private maximum and a merchant gives SpendSeal an encrypted private minimum. Their agents negotiate for at most three rounds without exposing either boundary. An accepted price becomes a single-use PurchasePermit that only the buyer can approve with a passkey. SpendSeal then revalidates Shopify, checks both authorities and creates exactly one Razorpay Test Mode order. The merchant sees verified constraint-recovered Test Mode GMV, while replay or policy changes create no second order.

## Judge questions and short answers

### Why can ChatGPT not do this alone?

ChatGPT operates the workflow, but SpendSeal is an independent control plane. It keeps the merchant floor outside the model, freezes the buyer ceiling, requires buyer-held passkey approval, revalidates Shopify after approval, claims exactly one payment attempt and records the decision chain.

### Is the merchant floor sent to ChatGPT?

No. It is AES-256-GCM encrypted and absent from MCP responses, buyer APIs, analytics, logs and buyer-facing audit events.

### Is this an LLM negotiating randomly?

No. ChatGPT chooses offers within the buyer's fixed maximum. The merchant response is a deterministic, versioned three-round policy. This makes the money decision repeatable and explainable.

### How is this Track 01 merchant growth?

The public price is above the buyer's ceiling, so ordinary checkout cannot convert. The agents create an acceptable price and complete one verified Razorpay Test Mode payment. The recovered conversion and GMV are measured on the merchant dashboard.

### Is this real merchant revenue?

No. The Buildathon flow uses Razorpay Test Mode. The UI and pitch call it Test Mode GMV, never real revenue.

### Can the AI increase the buyer's maximum?

No. The ceiling is fixed when the deal starts. Offers above it are rejected.

### Can SpendSeal sell below the merchant's minimum?

No. Final acceptance and post-approval policy revalidation both check the encrypted current merchant authority.

### What happens if Shopify price or merchant policy changes?

The deal or permit is invalidated. SpendSeal creates no Razorpay order.

### Why is a passkey required after the deal is accepted?

Negotiation finds valid terms; it does not authorize spending. The passkey keeps final buyer approval outside ChatGPT.

### What stops duplicate payment?

SpendSeal atomically claims one execution attempt. Reuse returns `REPLAY_DETECTED`, and an uncertain provider result is never retried automatically.

### Is the audit chain blockchain?

No. It is an append-only, SHA-256-linked PostgreSQL chain that is tamper-evident inside SpendSeal's trust domain. It is not externally anchored.

### What is the main v1 limitation?

It negotiates price for one INR product at quantity one. Multi-product bundles, shipping terms, subscriptions, currencies and public production operations are future work.

### What about Amazon and Flipkart?

They remain a secondary browser-observed capability. The primary Buildathon proof is stronger: it makes the connected Shopify merchant AI-transactable and completes a provider-verified Razorpay Test Mode payment.

## Words to use carefully

Say:

- Razorpay Test Mode payment.
- Constraint-recovered Test Mode GMV.
- Encrypted merchant minimum.
- Buyer-approved PurchasePermit.
- Deterministic policy agent.
- Tamper-evident audit chain.
- Shopify-authoritative catalog evidence.

Do not say:

- Real revenue was earned.
- The merchant minimum is mathematically impossible to discover.
- The audit is blockchain.
- Passkeys prove legal identity or KYC.
- Browser-observed evidence is provider-verified.
- SpendSeal bypasses OTP, CAPTCHA, bank or website security.

## Final recording checklist

- Record at 1080p or higher.
- Keep the cursor slow and visible.
- Use the same browser profile throughout.
- Keep the product, accepted deal, permit and audit tabs ready.
- Keep the ChatGPT prompts in a plain-text note for copy-paste.
- Never show secrets or environment variables.
- Say **Test Mode** every time you mention GMV or payment.
- Show at least one successful payment and one safe failure.
- Show that the merchant floor is absent from buyer evidence.
- Finish under five minutes; use the thirty-second pitch if time is running out.

## Submission checklist

- Main video uses the merchant dealmaker flow, not Amazon or Flipkart.
- The first 35 seconds state the lost-conversion problem.
- The successful path includes negotiation, PurchasePermit, passkey and Razorpay Test Mode payment.
- Merchant analytics show INR 45 recovered Test Mode GMV.
- Replay shows `REPLAY_DETECTED` and no second order.
- README, production site and spoken claims use the same values and terminology.
- The backup evidence is open before judging starts.
