# Security policy

SpendSeal is a Buildathon prototype that operates only with Razorpay Test Mode. Do not use it to authorize live payments.

## Secrets

- Keep `.env` local and untracked.
- Never commit or share `RAZORPAY_KEY_SECRET` or `RAZORPAY_WEBHOOK_SECRET`.
- Never provide ChatGPT cookies, session credentials, or browser storage to SpendSeal.
- Rotate any credential that is accidentally exposed.

## Trust boundaries

MCP tool metadata helps clients choose safe behavior but is not an authorization control. SpendSeal enforces constraints on the server and provides no MCP approval action. The browser exchanges the bearer link for a PurchasePermit-scoped HttpOnly session, removes it from the URL, and requires a user-verified WebAuthn assertion. This proves control of the enrolled authenticator; it is not KYC or legal identity verification.

Merchant-managed catalog data—whether published directly or synchronized from Shopify—is authoritative within the merchant trust domain. SpendSeal detects post-permit changes; it does not independently prove merchant honesty or force a merchant to honour stated refund terms later.

The audit ledger is SHA-256 hash-linked and protected from ordinary application updates/deletes by SQLite triggers. It is tamper-evident, not blockchain, absolutely tamper-proof, or an externally anchored immutable ledger.

Report security issues privately to the repository owner rather than opening a public exploit issue.
