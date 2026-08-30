import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  BrowserPurchasePermitSchema,
  BrowserOperatorActionSchema,
  CheckoutObservationSchema,
  CreateShoppingTaskInputSchema,
  CreateWebPurchaseTaskInputSchema,
  ProductSelectionProposalSchema,
  RedactedPageSnapshotSchema,
  ShoppingCandidateSchema,
  ShoppingTaskSchema,
  allowedShoppingHost,
  checkoutSnapshotHash,
  evaluateBrowserCheckout,
  hashAuditPayload,
  safeUsdAmountMinor,
  sha256,
  type BrowserPurchasePermit,
  type BrowserOperatorAction,
  type CheckoutObservation,
  type CreateShoppingTaskInput,
  type CreateWebPurchaseTaskInput,
  type PaymentPreference,
  type ReasonCode,
  type ShoppingCandidate,
  type ShoppingTask,
  type ProductSelectionProposal,
  type RedactedPageSnapshot,
} from "@spendseal/core";
import { transaction } from "./db/client.js";

export type BrowserPrincipal = { userId: string; clientId: string; scopes: string[] };
export type ShoppingAuditEvent = {
  id: string; taskId: string; buyerId: string; sequence: number; eventType: string; actor: string; reasonCode: ReasonCode | null;
  adapterId: string | null; adapterVersion: string | null; evidenceAssurance: "provider_verified" | "browser_observed" | "agent_assisted" | "prepared_only";
  payload: unknown; previousHash: string; hash: string; createdAt: string;
};
export type BrowserExecutionResult = {
  executionGrant: string;
  status: "completed" | "user_action_required" | "reconciliation_required" | "failed";
  detail?: string;
};

export class BrowserAgentService {
  constructor(private readonly pool: Pool, private readonly livePurchaseEnabled = false, private readonly enabled = true, private readonly openAiCreditsLiveEnabled = false, private readonly genericWebLiveEnabled = false) {}
  get liveModeEnabled(): boolean { return this.enabled && this.livePurchaseEnabled; }
  async liveModeEnabledFor(buyerId: string): Promise<boolean> {
    if (!this.liveModeEnabled) return false;
    const result = await this.pool.query("SELECT browser_live_purchase_enabled FROM users WHERE id=$1 AND status='active'", [buyerId]);
    return result.rows[0]?.browser_live_purchase_enabled === true;
  }

  async liveModePreference(buyerId: string): Promise<{ available: boolean; enabled: boolean }> {
    return { available: this.liveModeEnabled, enabled: await this.liveModeEnabledFor(buyerId) };
  }

  async setLiveModePreference(buyerId: string, enabled: boolean): Promise<{ available: boolean; enabled: boolean }> {
    if (enabled && !this.liveModeEnabled) throw new Error("LIVE_PURCHASE_DISABLED");
    const result = await this.pool.query("UPDATE users SET browser_live_purchase_enabled=$2 WHERE id=$1 AND status='active' RETURNING browser_live_purchase_enabled", [buyerId, enabled]);
    if (!result.rows[0]) throw new Error("SHOPPING_TASK_NOT_FOUND");
    return { available: this.liveModeEnabled, enabled: result.rows[0].browser_live_purchase_enabled === true };
  }

  async createTask(buyerId: string, raw: CreateShoppingTaskInput): Promise<ShoppingTask> {
    this.ensureEnabled();
    const input = CreateShoppingTaskInputSchema.parse(raw);
    return transaction(this.pool, async (client) => {
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString();
      const mode = await this.liveModeEnabledFor(buyerId) ? "live" : "prepare_only";
      const allowedOrigin = input.site === "amazon_in" ? "https://www.amazon.in" : "https://www.flipkart.com";
      const result = await client.query(`INSERT INTO shopping_tasks(id,buyer_id,site,query,product_url,max_total_paise,require_refundable,minimum_return_window_days,latest_delivery_date,status,mode,expires_at,allowed_origin,purchase_kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting_for_extension',$10,$11,$12,'physical_good') RETURNING *`,
      [id, buyerId, input.site, input.query ?? null, input.productUrl ?? null, input.maxTotalPaise, input.requireRefundable, input.minimumReturnWindowDays, input.latestDeliveryDate, mode, expiresAt, allowedOrigin]);
      await this.appendAudit(client, id, buyerId, "SHOPPING_TASK_CREATED", "chatgpt", null, { site: input.site, query: input.query ?? null, productUrl: input.productUrl ?? null, maxTotalPaise: input.maxTotalPaise, mode });
      return mapTask(result.rows[0]);
    });
  }

  async createWebTask(buyerId: string, raw: CreateWebPurchaseTaskInput): Promise<ShoppingTask> {
    this.ensureEnabled();
    const input = CreateWebPurchaseTaskInputSchema.parse(raw);
    return transaction(this.pool, async (client) => {
      const id = randomUUID(); const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString();
      const siteLiveEnabled = input.site === "openai_api" ? this.openAiCreditsLiveEnabled : input.site === "generic_web" ? this.genericWebLiveEnabled : true;
      const mode = await this.liveModeEnabledFor(buyerId) && siteLiveEnabled ? "live" : "prepare_only";
      const result = await client.query(`INSERT INTO shopping_tasks(id,buyer_id,site,query,product_url,max_total_paise,require_refundable,minimum_return_window_days,latest_delivery_date,status,mode,expires_at,allowed_origin,purchase_kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting_for_extension',$10,$11,$12,$13) RETURNING *`,
      [id, buyerId, input.site, input.objective, input.siteUrl, input.maxTotalPaise, input.requireRefundable, input.minimumReturnWindowDays, input.latestDeliveryDate, mode, expiresAt, input.allowedOrigin, input.purchaseKind]);
      await this.appendAudit(client, id, buyerId, "WEB_PURCHASE_TASK_CREATED", "chatgpt", null, { site: input.site, allowedOrigin: input.allowedOrigin, objective: input.objective, maxTotalPaise: input.maxTotalPaise, purchaseKind: input.purchaseKind, recurringAllowed: false, mode }, input.site, "2.0.0", input.site === "generic_web" ? "agent_assisted" : "browser_observed");
      return mapTask(result.rows[0]);
    });
  }

  async getTask(taskId: string, buyerId: string): Promise<{ task: ShoppingTask; candidates: ShoppingCandidate[]; permit: BrowserPurchasePermit | null; proposal: ProductSelectionProposal | null }> {
    this.ensureEnabled();
    const [taskResult, candidatesResult, permitResult, proposalResult] = await Promise.all([
      this.pool.query("SELECT * FROM shopping_tasks WHERE id=$1 AND buyer_id=$2", [taskId, buyerId]),
      this.pool.query("SELECT * FROM shopping_candidates WHERE task_id=$1 ORDER BY selected DESC,created_at", [taskId]),
      this.pool.query("SELECT * FROM browser_purchase_permits WHERE task_id=$1 AND buyer_id=$2", [taskId, buyerId]),
      this.pool.query("SELECT * FROM shopping_selection_proposals WHERE task_id=$1 AND status='pending' AND expires_at>now() ORDER BY created_at DESC LIMIT 1", [taskId]),
    ]);
    if (!taskResult.rows[0]) throw new Error("SHOPPING_TASK_NOT_FOUND");
    return { task: mapTask(taskResult.rows[0]), candidates: candidatesResult.rows.map(mapCandidate), permit: permitResult.rows[0] ? mapPermit(permitResult.rows[0]) : null, proposal: proposalResult.rows[0] ? mapProposal(proposalResult.rows[0]) : null };
  }

  async listTasks(buyerId: string, pendingOnly = false): Promise<ShoppingTask[]> {
    this.ensureEnabled();
    const terminal = ["prepared", "completed", "denied", "failed", "expired", "reconciliation_required"];
    const result = pendingOnly
      ? await this.pool.query("SELECT * FROM shopping_tasks WHERE buyer_id=$1 AND NOT(status=ANY($2::text[])) AND expires_at>now() ORDER BY created_at LIMIT 20", [buyerId, terminal])
      : await this.pool.query("SELECT * FROM shopping_tasks WHERE buyer_id=$1 ORDER BY created_at DESC LIMIT 50", [buyerId]);
    return result.rows.map(mapTask);
  }

  async registerInstallation(principal: BrowserPrincipal, input: { installationId: string; name: string }): Promise<void> {
    this.ensureEnabled();
    const result = await this.pool.query(`INSERT INTO browser_installations(id,buyer_id,oauth_client_id,name) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET last_seen_at=now(),name=EXCLUDED.name WHERE browser_installations.buyer_id=EXCLUDED.buyer_id AND browser_installations.revoked_at IS NULL`,
    [input.installationId, principal.userId, principal.clientId, input.name.slice(0, 80)]);
    if (!result.rowCount) throw new Error("INSTALLATION_NOT_AUTHORIZED");
  }

  async revokeInstallation(buyerId: string, installationId: string): Promise<boolean> {
    this.ensureEnabled();
    const result = await this.pool.query(
      "UPDATE browser_installations SET revoked_at=now() WHERE id=$1 AND buyer_id=$2 AND revoked_at IS NULL",
      [installationId, buyerId],
    );
    return Boolean(result.rowCount);
  }

  async saveCandidates(buyerId: string, installationId: string, taskId: string, rawCandidates: unknown[]): Promise<ShoppingCandidate[]> {
    this.ensureEnabled();
    if (rawCandidates.length < 1 || rawCandidates.length > 3) throw new Error("CANDIDATE_COUNT_INVALID");
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      if (!["waiting_for_extension", "searching"].includes(task.status)) throw new Error("TASK_STATE_INVALID");
      const candidates = rawCandidates.map((raw) => ShoppingCandidateSchema.omit({ id: true, taskId: true, selected: true }).parse(raw));
      if (candidates.some((candidate) => candidate.adapterId !== task.site || !allowedShoppingHost(task.site, candidate.productUrl, task.allowedOrigin))) {
        throw new Error("DOMAIN_MISMATCH");
      }
      await client.query("DELETE FROM shopping_candidates WHERE task_id=$1", [taskId]);
      const saved: ShoppingCandidate[] = [];
      for (const candidate of candidates) {
        const id = randomUUID();
        const result = await client.query(`INSERT INTO shopping_candidates(id,task_id,canonical_product_id,listing_id,title,seller,variant,condition,availability,price_paise,currency,product_url,snapshot_hash,observed_at,adapter_id,adapter_version,image_url,rating,review_count,delivery_estimate,ranking_reasons_json,proposal_source,query_mismatch)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [id, taskId, candidate.canonicalProductId, candidate.listingId, candidate.title, candidate.seller, candidate.variant, candidate.condition, candidate.availability, candidate.pricePaise, candidate.currency, candidate.productUrl, candidate.snapshotHash, candidate.observedAt, candidate.adapterId, candidate.adapterVersion, candidate.imageUrl, candidate.rating, candidate.reviewCount, candidate.deliveryEstimate, JSON.stringify(candidate.rankingReasons), candidate.proposalSource, candidate.queryMismatch]);
        saved.push(mapCandidate(result.rows[0]));
      }
      await client.query("UPDATE shopping_tasks SET status='selection_required',updated_at=now() WHERE id=$1", [taskId]);
      await client.query(`INSERT INTO browser_observations(id,task_id,installation_id,kind,adapter_id,adapter_version,source_url,snapshot_json,snapshot_hash,observed_at)
        VALUES($1,$2,$3,'candidates',$4,$5,$6,$7,$8,$9)`, [randomUUID(), taskId, installationId, candidates[0]!.adapterId, candidates[0]!.adapterVersion, candidates[0]!.productUrl, JSON.stringify(saved), sha256(saved), candidates[0]!.observedAt]);
      await this.appendAudit(client, taskId, buyerId, "CANDIDATES_OBSERVED", "browser_extension", null, { count: saved.length }, candidates[0]!.adapterId, candidates[0]!.adapterVersion);
      return saved;
    });
  }

  async proposeCandidate(taskId: string, buyerId: string, installationId: string, input: { candidateId?: string; candidate?: unknown; source: "recommended" | "manual" | "agent" }): Promise<{ task: ShoppingTask; candidate: ShoppingCandidate; proposal: ProductSelectionProposal }> {
    this.ensureEnabled();
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      if (["submitting", "completed", "prepared", "reconciliation_required"].includes(task.status)) throw new Error("REPLAY_DETECTED");
      let candidate: ShoppingCandidate;
      if (input.candidateId) {
        const found = await client.query("SELECT * FROM shopping_candidates WHERE id=$1 AND task_id=$2", [input.candidateId, taskId]);
        if (!found.rows[0]) throw new Error("CANDIDATE_NOT_FOUND"); candidate = mapCandidate(found.rows[0]);
      } else {
        const parsed = ShoppingCandidateSchema.omit({ id: true, taskId: true, selected: true }).parse({ ...(input.candidate as object), proposalSource: input.source });
        if (parsed.adapterId !== task.site || !allowedShoppingHost(task.site, parsed.productUrl, task.allowedOrigin)) throw new Error("DOMAIN_MISMATCH");
        const existing = await client.query("SELECT * FROM shopping_candidates WHERE task_id=$1 AND canonical_product_id=$2 AND product_url=$3", [taskId, parsed.canonicalProductId, parsed.productUrl]);
        if (existing.rows[0]) {
          await client.query(`UPDATE shopping_candidates SET title=$2,seller=$3,variant=$4,price_paise=$5,snapshot_hash=$6,observed_at=$7,image_url=$8,rating=$9,review_count=$10,delivery_estimate=$11,ranking_reasons_json=$12,proposal_source=$13,query_mismatch=$14 WHERE id=$1`, [existing.rows[0].id, parsed.title, parsed.seller, parsed.variant, parsed.pricePaise, parsed.snapshotHash, parsed.observedAt, parsed.imageUrl, parsed.rating, parsed.reviewCount, parsed.deliveryEstimate, JSON.stringify(parsed.rankingReasons), input.source, parsed.queryMismatch]);
          candidate = mapCandidate((await client.query("SELECT * FROM shopping_candidates WHERE id=$1", [existing.rows[0].id])).rows[0]);
        } else {
          const id = randomUUID(); const created = await client.query(`INSERT INTO shopping_candidates(id,task_id,canonical_product_id,listing_id,title,seller,variant,condition,availability,price_paise,currency,product_url,snapshot_hash,observed_at,adapter_id,adapter_version,image_url,rating,review_count,delivery_estimate,ranking_reasons_json,proposal_source,query_mismatch)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`, [id, taskId, parsed.canonicalProductId, parsed.listingId, parsed.title, parsed.seller, parsed.variant, parsed.condition, parsed.availability, parsed.pricePaise, parsed.currency, parsed.productUrl, parsed.snapshotHash, parsed.observedAt, parsed.adapterId, parsed.adapterVersion, parsed.imageUrl, parsed.rating, parsed.reviewCount, parsed.deliveryEstimate, JSON.stringify(parsed.rankingReasons), input.source, parsed.queryMismatch]);
          candidate = mapCandidate(created.rows[0]);
        }
      }
      const queryMismatch = task.query ? !queryMatches(task.query, candidate.title) : false;
      const warning = candidate.pricePaise > task.maxTotalPaise ? "This product already exceeds the complete task budget before checkout charges."
        : queryMismatch ? "This product differs from the original request. Review it carefully before continuing." : null;
      await client.query("UPDATE shopping_selection_proposals SET status='replaced' WHERE task_id=$1 AND status='pending'", [taskId]);
      await client.query("UPDATE shopping_candidates SET selected=false WHERE task_id=$1", [taskId]);
      if (task.purchasePermitId) await client.query("UPDATE browser_purchase_permits SET status='denied' WHERE id=$1 AND status IN ('pending_confirmation','confirmed')", [task.purchasePermitId]);
      if (task.selectedCandidateId || task.purchasePermitId) {
        await this.appendAudit(client, taskId, buyerId, "PRODUCT_SELECTION_INVALIDATED", "browser_extension", "PRODUCT_CHANGED", {
          previousCandidateId: task.selectedCandidateId,
          previousPurchasePermitId: task.purchasePermitId,
          approvalsAndExecutionGrantsInvalidated: true,
        }, candidate.adapterId, candidate.adapterVersion, candidate.adapterId === "generic_web" ? "agent_assisted" : "browser_observed");
      }
      const proposalId = randomUUID(); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const created = await client.query(`INSERT INTO shopping_selection_proposals(id,task_id,candidate_id,installation_id,source,status,query_mismatch,warning,expires_at)
        VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8) RETURNING *`, [proposalId, taskId, candidate.id, installationId, input.source, queryMismatch, warning, expiresAt]);
      const updated = await client.query("UPDATE shopping_tasks SET proposed_candidate_id=$2,selected_candidate_id=NULL,purchase_permit_id=NULL,checkout_snapshot_hash=NULL,confirmed_at=NULL,selection_confirmed_at=NULL,status='product_review_required',updated_at=now() WHERE id=$1 RETURNING *", [taskId, candidate.id]);
      await this.appendAudit(client, taskId, buyerId, "PRODUCT_REVIEW_PROPOSED", "browser_extension", null, { proposalId, candidateId: candidate.id, canonicalProductId: candidate.canonicalProductId, source: input.source, queryMismatch, warning }, candidate.adapterId, candidate.adapterVersion, candidate.adapterId === "generic_web" ? "agent_assisted" : "browser_observed");
      return { task: mapTask(updated.rows[0]), candidate, proposal: mapProposal(created.rows[0]) };
    });
  }

  async confirmCandidate(taskId: string, buyerId: string, installationId: string, proposalId: string): Promise<ShoppingTask> {
    this.ensureEnabled();
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      const result = await client.query("SELECT * FROM shopping_selection_proposals WHERE id=$1 AND task_id=$2 AND status='pending' AND expires_at>now() FOR UPDATE", [proposalId, taskId]);
      if (!result.rows[0]) throw new Error("PRODUCT_REVIEW_REQUIRED");
      const candidateResult = await client.query("SELECT * FROM shopping_candidates WHERE id=$1 AND task_id=$2", [result.rows[0].candidate_id, taskId]); const candidate = mapCandidate(candidateResult.rows[0]);
      if (candidate.pricePaise > task.maxTotalPaise) throw new Error("BUDGET_EXCEEDED");
      const now = new Date().toISOString(); await client.query("UPDATE shopping_selection_proposals SET status='confirmed',confirmed_at=$2 WHERE id=$1", [proposalId, now]);
      await client.query("UPDATE shopping_candidates SET selected=(id=$2) WHERE task_id=$1", [taskId, candidate.id]);
      const updated = await client.query("UPDATE shopping_tasks SET proposed_candidate_id=NULL,selected_candidate_id=$2,selection_confirmed_at=$3,status='selection_confirmed',updated_at=now() WHERE id=$1 RETURNING *", [taskId, candidate.id, now]);
      await this.appendAudit(client, taskId, buyerId, "PRODUCT_SELECTION_CONFIRMED", "buyer", null, { proposalId, candidateId: candidate.id, canonicalProductId: candidate.canonicalProductId });
      return mapTask(updated.rows[0]);
    });
  }

  async dismissCandidate(taskId: string, buyerId: string, installationId: string, proposalId: string): Promise<ShoppingTask> {
    return transaction(this.pool, async (client) => {
      await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      const dismissed = await client.query("UPDATE shopping_selection_proposals SET status='dismissed' WHERE id=$1 AND task_id=$2 AND status='pending' RETURNING id", [proposalId, taskId]);
      if (!dismissed.rowCount) throw new Error("PRODUCT_REVIEW_REQUIRED");
      const updated = await client.query("UPDATE shopping_tasks SET proposed_candidate_id=NULL,status='selection_required',updated_at=now() WHERE id=$1 RETURNING *", [taskId]);
      await this.appendAudit(client, taskId, buyerId, "PRODUCT_REVIEW_DISMISSED", "buyer", null, { proposalId }); return mapTask(updated.rows[0]);
    });
  }

  async setPaymentPreference(taskId: string, buyerId: string, installationId: string, paymentPreference: PaymentPreference): Promise<ShoppingTask> {
    this.ensureEnabled();
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      if (!task.selectedCandidateId || !["navigating", "checkout_configuring", "payment_choice_required", "payment_action_required"].includes(task.status)) throw new Error("TASK_STATE_INVALID");
      const status = paymentPreference === "online" ? "payment_action_required" : "checkout_configuring";
      const result = await client.query("UPDATE shopping_tasks SET payment_preference=$2,status=$3,updated_at=now() WHERE id=$1 RETURNING *", [taskId, paymentPreference, status]);
      await this.appendAudit(client, taskId, buyerId, "PAYMENT_PREFERENCE_SELECTED", "buyer", null, { paymentPreference });
      return mapTask(result.rows[0]);
    });
  }

  async reportStatus(taskId: string, buyerId: string, installationId: string, status: "searching" | "navigating" | "checkout_configuring" | "payment_choice_required" | "payment_action_required" | "user_action_required" | "failed", detail?: string): Promise<void> {
    this.ensureEnabled();
    await transaction(this.pool, async (client) => {
      await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      await client.query("UPDATE shopping_tasks SET status=$2,updated_at=now() WHERE id=$1", [taskId, status]);
      await this.appendAudit(client, taskId, buyerId, status === "user_action_required" ? "USER_ACTION_REQUIRED" : "BROWSER_PROGRESS", "browser_extension", status === "user_action_required" ? "USER_ACTION_REQUIRED" : null, { status, detail: detail?.slice(0, 240) ?? null });
    });
  }

  async recordSiteGrant(taskId: string, buyerId: string, installationId: string, origin: string): Promise<void> {
    this.ensureEnabled();
    await transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      const requestedOrigin = new URL(origin).origin; const expectedOrigin = task.site === "generic_web" ? task.allowedOrigin : requestedOrigin;
      if (!expectedOrigin || !allowedShoppingHost(task.site, requestedOrigin, task.allowedOrigin)) throw new Error("DOMAIN_MISMATCH");
      await client.query(`INSERT INTO browser_site_grants(id,task_id,installation_id,origin) VALUES($1,$2,$3,$4)
        ON CONFLICT(task_id,installation_id,origin) DO UPDATE SET revoked_at=NULL,granted_at=now()`, [randomUUID(), taskId, installationId, expectedOrigin]);
      await this.appendAudit(client, taskId, buyerId, "SITE_PERMISSION_GRANTED", "buyer", null, { origin: expectedOrigin, installationId });
    });
  }

  async saveRedactedPage(taskId: string, buyerId: string, installationId: string, raw: unknown): Promise<RedactedPageSnapshot> {
    this.ensureEnabled(); const snapshot = RedactedPageSnapshotSchema.parse(raw);
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      if (!allowedShoppingHost(task.site, snapshot.url, task.allowedOrigin)) throw new Error("DOMAIN_MISMATCH");
      const hash = sha256(snapshot); await client.query(`INSERT INTO browser_observations(id,task_id,installation_id,kind,adapter_id,adapter_version,source_url,snapshot_json,snapshot_hash,observed_at)
        VALUES($1,$2,$3,'redacted_page',$4,'2.0.0',$5,$6,$7,$8)`, [randomUUID(), taskId, installationId, task.site, snapshot.url, snapshot, hash, snapshot.capturedAt]);
      await this.appendAudit(client, taskId, buyerId, "REDACTED_PAGE_OBSERVED", "browser_extension", null, { url: snapshot.url, controlCount: snapshot.controls.length, textItemCount: snapshot.text.length, snapshotHash: hash, screenshotIncluded: false }, task.site, "2.0.0", task.site === "generic_web" ? "agent_assisted" : "browser_observed");
      return snapshot;
    });
  }

  async operatorState(taskId: string, buyerId: string): Promise<{ task: ShoppingTask; snapshot: RedactedPageSnapshot | null; commands: unknown[] }> {
    const task = await this.getTask(taskId, buyerId).then((value) => value.task);
    const [snapshot, commands] = await Promise.all([
      this.pool.query("SELECT snapshot_json FROM browser_observations WHERE task_id=$1 AND kind IN ('redacted_page','operator_result') ORDER BY created_at DESC LIMIT 1", [taskId]),
      this.pool.query("SELECT id,sequence,action_json,status,result_json,created_at,completed_at FROM browser_operator_commands WHERE task_id=$1 ORDER BY sequence DESC LIMIT 20", [taskId]),
    ]);
    return { task, snapshot: snapshot.rows[0] ? RedactedPageSnapshotSchema.parse(snapshot.rows[0].snapshot_json) : null, commands: commands.rows };
  }

  async fxQuote(taskId: string, buyerId: string): Promise<{ base: "USD"; quote: "INR"; rate: number; bufferPercent: 10; source: string; quotedAt: string; safeProviderAmountMinor: number }> {
    this.ensureEnabled(); const task = await this.getTask(taskId, buyerId).then((value) => value.task); if (task.purchaseKind !== "api_credits") throw new Error("FX_QUOTE_UNAVAILABLE");
    const cached = await this.pool.query("SELECT * FROM browser_fx_quotes WHERE task_id=$1 AND expires_at>now() ORDER BY quoted_at DESC LIMIT 1", [taskId]);
    let row = cached.rows[0];
    if (!row) {
      const response = await fetch("https://api.frankfurter.app/latest?from=USD&to=INR", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("FX_QUOTE_UNAVAILABLE"); const data = await response.json() as { rates?: { INR?: number } }; const rate = Number(data.rates?.INR); if (!Number.isFinite(rate) || rate <= 0) throw new Error("FX_QUOTE_UNAVAILABLE");
      const id = randomUUID(); const quotedAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      row = (await this.pool.query("INSERT INTO browser_fx_quotes(id,task_id,base_currency,quote_currency,rate,buffer_percent,source,quoted_at,expires_at) VALUES($1,$2,'USD','INR',$3,10,'Frankfurter / ECB reference rate',$4,$5) RETURNING *", [id, taskId, rate, quotedAt, expiresAt])).rows[0];
    }
    const rate = Number(row.rate); const safeProviderAmountMinor = safeUsdAmountMinor(task.maxTotalPaise, rate, 10);
    return { base: "USD", quote: "INR", rate, bufferPercent: 10, source: row.source, quotedAt: iso(row.quoted_at)!, safeProviderAmountMinor };
  }

  async queueOperatorAction(taskId: string, buyerId: string, raw: unknown): Promise<{ commandId: string; sequence: number; status: "queued" }> {
    this.ensureEnabled(); const action = BrowserOperatorActionSchema.parse(raw);
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId);
      if (["pending_approval", "approved", "submitting", "completed", "prepared", "denied", "reconciliation_required"].includes(task.status)) throw new Error("TASK_STATE_INVALID");
      if (action.type === "navigate" && !allowedShoppingHost(task.site, action.url, task.allowedOrigin)) throw new Error("DOMAIN_MISMATCH");
      const sequence = Number((await client.query("SELECT COALESCE(max(sequence),0)+1 AS next FROM browser_operator_commands WHERE task_id=$1", [taskId])).rows[0].next);
      const commandId = randomUUID(); await client.query("INSERT INTO browser_operator_commands(id,task_id,sequence,action_json) VALUES($1,$2,$3,$4)", [commandId, taskId, sequence, action]);
      await client.query("UPDATE shopping_tasks SET status='operator_navigating',updated_at=now() WHERE id=$1", [taskId]);
      await this.appendAudit(client, taskId, buyerId, "OPERATOR_ACTION_QUEUED", "chatgpt", null, { commandId, sequence, actionType: action.type }, task.site, "2.0.0", task.site === "generic_web" ? "agent_assisted" : "browser_observed");
      return { commandId, sequence, status: "queued" };
    });
  }

  async claimOperatorCommand(taskId: string, buyerId: string, installationId: string): Promise<{ id: string; sequence: number; action: BrowserOperatorAction } | null> {
    return transaction(this.pool, async (client) => {
      await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      const result = await client.query("SELECT * FROM browser_operator_commands WHERE task_id=$1 AND status='queued' ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED", [taskId]);
      if (!result.rows[0]) return null; await client.query("UPDATE browser_operator_commands SET status='claimed',installation_id=$2,claimed_at=now() WHERE id=$1", [result.rows[0].id, installationId]);
      return { id: result.rows[0].id, sequence: result.rows[0].sequence, action: BrowserOperatorActionSchema.parse(result.rows[0].action_json) };
    });
  }

  async completeOperatorCommand(taskId: string, buyerId: string, installationId: string, commandId: string, input: { status: "completed" | "blocked" | "failed"; result?: unknown; snapshot?: unknown }): Promise<void> {
    await transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      const result = await client.query("UPDATE browser_operator_commands SET status=$4,result_json=$5,completed_at=now() WHERE id=$1 AND task_id=$2 AND installation_id=$3 AND status='claimed' RETURNING sequence", [commandId, taskId, installationId, input.status, input.result ?? null]);
      if (!result.rowCount) throw new Error("OPERATOR_COMMAND_INVALID");
      if (input.snapshot) {
        const snapshot = RedactedPageSnapshotSchema.parse(input.snapshot); if (!allowedShoppingHost(task.site, snapshot.url, task.allowedOrigin)) throw new Error("DOMAIN_MISMATCH");
        await client.query(`INSERT INTO browser_observations(id,task_id,installation_id,kind,adapter_id,adapter_version,source_url,snapshot_json,snapshot_hash,observed_at)
          VALUES($1,$2,$3,'operator_result',$4,'2.0.0',$5,$6,$7,$8)`, [randomUUID(), taskId, installationId, task.site, snapshot.url, snapshot, sha256(snapshot), snapshot.capturedAt]);
      }
      await this.appendAudit(client, taskId, buyerId, input.status === "blocked" ? "OPERATOR_ACTION_BLOCKED" : "OPERATOR_ACTION_COMPLETED", "browser_extension", input.status === "blocked" ? "SENSITIVE_FIELD_BLOCKED" : null, { commandId, sequence: result.rows[0].sequence, status: input.status }, task.site, "2.0.0", task.site === "generic_web" ? "agent_assisted" : "browser_observed");
    });
  }

  async observeCheckout(taskId: string, buyerId: string, installationId: string, raw: unknown): Promise<{ task: ShoppingTask; permit: BrowserPurchasePermit | null; allowed: boolean; reasons: ReasonCode[] }> {
    this.ensureEnabled();
    const observation = CheckoutObservationSchema.parse(raw);
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      if (!task.selectedCandidateId || !["navigating", "checkout_configuring", "payment_action_required", "checkout_observed", "pending_approval"].includes(task.status)) throw new Error("TASK_STATE_INVALID");
      const candidateResult = await client.query("SELECT * FROM shopping_candidates WHERE id=$1 AND task_id=$2", [task.selectedCandidateId, taskId]);
      const candidate = candidateResult.rows[0] ? mapCandidate(candidateResult.rows[0]) : null;
      const decision = evaluateBrowserCheckout({ task, candidate, observation }); const snapshotHash = checkoutSnapshotHash(observation);
      await client.query(`INSERT INTO browser_observations(id,task_id,installation_id,kind,adapter_id,adapter_version,source_url,snapshot_json,snapshot_hash,observed_at)
        VALUES($1,$2,$3,'checkout',$4,$5,$6,$7,$8,$9)`, [randomUUID(), taskId, installationId, observation.adapterId, observation.adapterVersion, observation.sourceUrl, observation, snapshotHash, observation.observedAt]);
      if (!decision.allowed) {
        const reason = decision.reasons[0]!;
        const denied = await client.query("UPDATE shopping_tasks SET status='denied',denial_reason=$2,updated_at=now() WHERE id=$1 RETURNING *", [taskId, reason]);
        await this.appendAudit(client, taskId, buyerId, "POLICY_DENIED", "policy_engine", reason, { reasons: decision.reasons, finalTotalPaise: observation.finalTotalPaise, snapshotHash }, observation.adapterId, observation.adapterVersion);
        return { task: mapTask(denied.rows[0]), permit: null, allowed: false, reasons: decision.reasons };
      }
      const permitId = randomUUID(); const permitExpiry = new Date(Date.now() + 10 * 60_000).toISOString();
      const permitResult = await client.query(`INSERT INTO browser_purchase_permits(id,task_id,buyer_id,checkout_snapshot_json,checkout_snapshot_hash,max_total_paise,status,expires_at,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,'pending_confirmation',$7,$8)
        ON CONFLICT(task_id) DO UPDATE SET checkout_snapshot_json=EXCLUDED.checkout_snapshot_json,checkout_snapshot_hash=EXCLUDED.checkout_snapshot_hash,status='pending_confirmation',expires_at=EXCLUDED.expires_at RETURNING *`,
      [permitId, taskId, buyerId, observation, snapshotHash, task.maxTotalPaise, permitExpiry, randomUUID()]);
      const permit = mapPermit(permitResult.rows[0]);
      const taskResult = await client.query("UPDATE shopping_tasks SET status='pending_approval',purchase_permit_id=$2,checkout_snapshot_hash=$3,updated_at=now() WHERE id=$1 RETURNING *", [taskId, permit.id, snapshotHash]);
      await this.appendAudit(client, taskId, buyerId, "CHECKOUT_OBSERVED", "browser_extension", null, { finalTotalPaise: observation.finalTotalPaise, maskedAddressLabel: observation.maskedAddressLabel, paymentMethodType: observation.paymentMethodType, snapshotHash }, observation.adapterId, observation.adapterVersion);
      return { task: mapTask(taskResult.rows[0]), permit, allowed: true, reasons: ["ALLOWED"] };
    });
  }

  async createApprovalContinuation(taskId: string, buyerId: string, installationId: string, input: { redirectUri: string; state: string }): Promise<{ continuationId: string; expiresAt: string }> {
    this.ensureEnabled();
    if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\/shopping-approval\/?$/.test(input.redirectUri)) throw new Error("APPROVAL_REDIRECT_INVALID");
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      if (task.status !== "pending_approval") throw new Error("TASK_STATE_INVALID");
      const continuationId = randomUUID(); const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await client.query("DELETE FROM browser_approval_continuations WHERE task_id=$1 AND consumed_at IS NULL", [taskId]);
      await client.query("INSERT INTO browser_approval_continuations(id,task_id,installation_id,redirect_uri,state,expires_at) VALUES($1,$2,$3,$4,$5,$6)", [continuationId, taskId, installationId, input.redirectUri, input.state, expiresAt]);
      await this.appendAudit(client, taskId, buyerId, "APPROVAL_CONTINUATION_CREATED", "browser_extension", null, { installationId, expiresAt });
      return { continuationId, expiresAt };
    });
  }

  async completeApprovalContinuation(taskId: string, buyerId: string, continuationId: string): Promise<{ redirectUrl: string }> {
    this.ensureEnabled();
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId);
      if (task.status !== "approved") throw new Error("CONFIRMATION_REQUIRED");
      const result = await client.query("SELECT * FROM browser_approval_continuations WHERE id=$1 AND task_id=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE", [continuationId, taskId]);
      const continuation = result.rows[0]; if (!continuation) throw new Error("APPROVAL_CONTINUATION_INVALID");
      await client.query("UPDATE browser_approval_continuations SET consumed_at=now() WHERE id=$1", [continuationId]);
      const redirect = new URL(continuation.redirect_uri); redirect.searchParams.set("state", continuation.state); redirect.searchParams.set("result", "approved"); redirect.searchParams.set("task_id", taskId);
      await this.appendAudit(client, taskId, buyerId, "APPROVAL_RETURNED_TO_EXTENSION", "system", null, { installationId: continuation.installation_id });
      return { redirectUrl: redirect.toString() };
    });
  }

  async restartProductSelection(taskId: string, buyerId: string, installationId?: string): Promise<ShoppingTask> {
    this.ensureEnabled();
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId);
      if (installationId) await this.assertInstallation(client, installationId, buyerId);
      return this.resetProductSelection(client, task, buyerId, installationId ? "browser_extension" : "buyer");
    });
  }

  async cancelApprovalContinuation(taskId: string, buyerId: string, continuationId: string): Promise<{ redirectUrl: string; task: ShoppingTask }> {
    this.ensureEnabled();
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId);
      const result = await client.query("SELECT * FROM browser_approval_continuations WHERE id=$1 AND task_id=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE", [continuationId, taskId]);
      const continuation = result.rows[0];
      if (!continuation) throw new Error("APPROVAL_CONTINUATION_INVALID");
      const restarted = await this.resetProductSelection(client, task, buyerId, "buyer");
      const redirect = new URL(continuation.redirect_uri);
      redirect.searchParams.set("state", continuation.state);
      redirect.searchParams.set("result", "cancelled");
      redirect.searchParams.set("task_id", taskId);
      return { redirectUrl: redirect.toString(), task: restarted };
    });
  }

  private async resetProductSelection(client: PoolClient, task: ShoppingTask, buyerId: string, actor: "buyer" | "browser_extension"): Promise<ShoppingTask> {
    if (["submitting", "completed", "prepared", "reconciliation_required", "expired"].includes(task.status)) throw new Error("REPLAY_DETECTED");
    if (await client.query("SELECT 1 FROM browser_execution_attempts WHERE task_id=$1", [task.id]).then((result) => result.rowCount)) throw new Error("REPLAY_DETECTED");
    await client.query("UPDATE shopping_selection_proposals SET status='replaced' WHERE task_id=$1 AND status='pending'", [task.id]);
    await client.query("UPDATE shopping_candidates SET selected=false WHERE task_id=$1", [task.id]);
    if (task.purchasePermitId) await client.query("UPDATE browser_purchase_permits SET status='denied' WHERE id=$1 AND status IN ('pending_confirmation','confirmed')", [task.purchasePermitId]);
    await client.query("UPDATE browser_approval_continuations SET consumed_at=now() WHERE task_id=$1 AND consumed_at IS NULL", [task.id]);
    const result = await client.query(`UPDATE shopping_tasks SET proposed_candidate_id=NULL,selected_candidate_id=NULL,purchase_permit_id=NULL,checkout_snapshot_hash=NULL,confirmed_at=NULL,selection_confirmed_at=NULL,payment_preference=NULL,denial_reason=NULL,status='searching',updated_at=now() WHERE id=$1 RETURNING *`, [task.id]);
    await this.appendAudit(client, task.id, buyerId, "PRODUCT_RESELECTION_REQUESTED", actor, null, {
      previousCandidateId: task.selectedCandidateId,
      previousPurchasePermitId: task.purchasePermitId,
      approvalAndExecutionGrantInvalidated: true,
    });
    return mapTask(result.rows[0]);
  }

  async approve(taskId: string, buyerId: string): Promise<ShoppingTask> {
    this.ensureEnabled();
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId);
      if (task.status !== "pending_approval" || !task.purchasePermitId) throw new Error("TASK_STATE_INVALID");
      const now = new Date().toISOString();
      await client.query("UPDATE browser_purchase_permits SET status='confirmed',confirmed_at=$2 WHERE id=$1 AND buyer_id=$3", [task.purchasePermitId, now, buyerId]);
      const result = await client.query("UPDATE shopping_tasks SET status='approved',confirmed_at=$2,updated_at=now() WHERE id=$1 RETURNING *", [taskId, now]);
      await this.appendAudit(client, taskId, buyerId, "PASSKEY_VERIFIED", "buyer", null, { checkoutSnapshotHash: task.checkoutSnapshotHash });
      await this.appendAudit(client, taskId, buyerId, "HUMAN_CONFIRMATION_RECORDED", "buyer", null, { assurance: "device_bound_passkey" });
      return mapTask(result.rows[0]);
    });
  }

  async claimExecution(taskId: string, buyerId: string, installationId: string, raw: unknown): Promise<{ status: "prepared" | "submitting" | "denied"; reason?: ReasonCode; executionGrant?: string; paymentPreference?: PaymentPreference }> {
    this.ensureEnabled();
    const observation = CheckoutObservationSchema.parse(raw);
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      if (await client.query("SELECT 1 FROM browser_execution_attempts WHERE task_id=$1", [taskId]).then((r) => r.rowCount)) {
        await this.appendAudit(client, taskId, buyerId, "REPLAY_BLOCKED", "policy_engine", "REPLAY_DETECTED", {});
        return { status: "denied", reason: "REPLAY_DETECTED" };
      }
      if (task.status !== "approved" || !task.purchasePermitId) throw new Error("CONFIRMATION_REQUIRED");
      const [candidateResult, permitResult] = await Promise.all([
        client.query("SELECT * FROM shopping_candidates WHERE id=$1 AND task_id=$2", [task.selectedCandidateId, taskId]),
        client.query("SELECT * FROM browser_purchase_permits WHERE id=$1 AND buyer_id=$2 FOR UPDATE", [task.purchasePermitId, buyerId]),
      ]);
      const permit = mapPermit(permitResult.rows[0]); const candidate = candidateResult.rows[0] ? mapCandidate(candidateResult.rows[0]) : null;
      const decision = evaluateBrowserCheckout({ task, candidate, observation, permit });
      if (!decision.allowed) {
        const reason = decision.reasons[0]!;
        await client.query("UPDATE shopping_tasks SET status='denied',denial_reason=$2,updated_at=now() WHERE id=$1", [taskId, reason]);
        await client.query("UPDATE browser_purchase_permits SET status='denied' WHERE id=$1", [permit.id]);
        await this.appendAudit(client, taskId, buyerId, "POLICY_DENIED", "policy_engine", reason, { reasons: decision.reasons }, observation.adapterId, observation.adapterVersion);
        return { status: "denied", reason };
      }
      await this.appendAudit(client, taskId, buyerId, "POLICY_ALLOWED", "policy_engine", null, { checkoutSnapshotHash: checkoutSnapshotHash(observation), finalTotalPaise: observation.finalTotalPaise }, observation.adapterId, observation.adapterVersion);
      await this.appendAudit(client, taskId, buyerId, "FINAL_REVALIDATION_PASSED", "policy_engine", null, { paymentPreference: task.paymentPreference, maskedPaymentMethodType: observation.paymentMethodType, checkoutSnapshotHash: checkoutSnapshotHash(observation) }, observation.adapterId, observation.adapterVersion);
      const attemptId = randomUUID();
      if (task.mode === "prepare_only") {
        await client.query("INSERT INTO browser_execution_attempts(id,task_id,installation_id,status,outcome_json) VALUES($1,$2,$3,'prepared',$4)", [attemptId, taskId, installationId, { submitted: false, reason: "showcase_prepare_only" }]);
        await client.query("UPDATE shopping_tasks SET status='prepared',updated_at=now() WHERE id=$1", [taskId]);
        await client.query("UPDATE browser_purchase_permits SET status='prepared' WHERE id=$1", [permit.id]);
        await this.appendAudit(client, taskId, buyerId, "PURCHASE_PREPARED", "browser_extension", null, { liveOrderSubmitted: false }, observation.adapterId, observation.adapterVersion, "prepared_only");
        return { status: "prepared" };
      }
      if (!await this.liveModeEnabledFor(buyerId)) {
        await this.appendAudit(client, taskId, buyerId, "POLICY_DENIED", "policy_engine", "LIVE_PURCHASE_DISABLED", { liveOrderSubmitted: false }, observation.adapterId, observation.adapterVersion);
        return { status: "denied", reason: "LIVE_PURCHASE_DISABLED" };
      }
      const grant = randomBytes(32).toString("base64url");
      await client.query("INSERT INTO browser_execution_attempts(id,task_id,installation_id,grant_token_hash,grant_expires_at,status) VALUES($1,$2,$3,$4,now()+interval '2 minutes','claimed')", [attemptId, taskId, installationId, sha256(grant)]);
      await client.query("UPDATE shopping_tasks SET status='submitting',updated_at=now() WHERE id=$1", [taskId]);
      await client.query("UPDATE browser_purchase_permits SET status='submitting' WHERE id=$1", [permit.id]);
      return { status: "submitting", executionGrant: grant, paymentPreference: task.paymentPreference ?? undefined };
    });
  }

  async reportExecution(
    taskId: string,
    buyerId: string,
    installationId: string,
    input: BrowserExecutionResult,
  ): Promise<{ status: BrowserExecutionResult["status"] }> {
    this.ensureEnabled();
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId);
      await this.assertInstallation(client, installationId, buyerId);
      if (task.status !== "submitting" || !task.purchasePermitId) {
        throw new Error("TASK_STATE_INVALID");
      }
      const attempt = await client.query(
        `SELECT * FROM browser_execution_attempts
         WHERE task_id=$1 AND installation_id=$2 FOR UPDATE`,
        [taskId, installationId],
      );
      const row = attempt.rows[0];
      if (
        !row || row.status !== "claimed" ||
        row.grant_token_hash !== sha256(input.executionGrant) ||
        !row.grant_expires_at ||
        new Date(row.grant_expires_at).getTime() <= Date.now()
      ) {
        throw new Error("EXECUTION_GRANT_INVALID");
      }
      const detail = input.detail?.slice(0, 240) ?? null;
      await client.query(
        `UPDATE browser_execution_attempts
         SET status=$2,outcome_json=$3,updated_at=now() WHERE id=$1`,
        [row.id, input.status, { detail }],
      );
      await client.query(
        "UPDATE shopping_tasks SET status=$2,updated_at=now() WHERE id=$1",
        [taskId, input.status],
      );
      const permitStatus = input.status === "completed"
        ? "completed"
        : input.status === "reconciliation_required"
          ? "reconciliation_required"
          : "denied";
      await client.query(
        "UPDATE browser_purchase_permits SET status=$2 WHERE id=$1",
        [task.purchasePermitId, permitStatus],
      );
      const eventType = input.status === "completed"
        ? "PURCHASE_COMPLETED"
        : input.status === "user_action_required"
          ? "USER_ACTION_REQUIRED"
          : input.status === "reconciliation_required"
            ? "EXECUTION_RECONCILIATION_REQUIRED"
            : "EXECUTION_FAILED";
      const reason = input.status === "user_action_required"
        ? "USER_ACTION_REQUIRED"
        : input.status === "reconciliation_required"
          ? "PAYMENT_PROVIDER_UNCERTAIN"
          : null;
      await this.appendAudit(
        client,
        taskId,
        buyerId,
        eventType,
        "browser_extension",
        reason,
        { detail, automaticRetryAllowed: false },
      );
      return { status: input.status };
    });
  }

  async audit(taskId: string, buyerId: string): Promise<{ events: ShoppingAuditEvent[]; verification: { valid: boolean; checked: number; brokenAt: number | null } }> {
    this.ensureEnabled();
    const owner = await this.pool.query("SELECT 1 FROM shopping_tasks WHERE id=$1 AND buyer_id=$2", [taskId, buyerId]); if (!owner.rowCount) throw new Error("SHOPPING_TASK_NOT_FOUND");
    const result = await this.pool.query("SELECT * FROM shopping_audit_events WHERE task_id=$1 ORDER BY sequence", [taskId]); const events = result.rows.map(mapAudit);
    let previous = "GENESIS"; let brokenAt: number | null = null;
    for (const event of events) { const material = auditMaterial(event); const expected = hashAuditPayload(previous, material); if (event.previousHash !== previous || event.hash !== expected) { brokenAt = event.sequence; break; } previous = event.hash; }
    return { events, verification: { valid: brokenAt === null, checked: events.length, brokenAt } };
  }

  private ensureEnabled(): void { if (!this.enabled) throw new Error("BROWSER_AGENT_DISABLED"); }
  private async lockTask(client: PoolClient, taskId: string, buyerId: string): Promise<ShoppingTask> { const result = await client.query("SELECT * FROM shopping_tasks WHERE id=$1 AND buyer_id=$2 FOR UPDATE", [taskId, buyerId]); if (!result.rows[0]) throw new Error("SHOPPING_TASK_NOT_FOUND"); return mapTask(result.rows[0]); }
  private async assertInstallation(client: PoolClient, installationId: string, buyerId: string): Promise<void> { const found = await client.query("UPDATE browser_installations SET last_seen_at=now() WHERE id=$1 AND buyer_id=$2 AND revoked_at IS NULL RETURNING id", [installationId, buyerId]); if (!found.rowCount) throw new Error("INSTALLATION_NOT_AUTHORIZED"); }
  private async appendAudit(client: PoolClient, taskId: string, buyerId: string, eventType: string, actor: string, reasonCode: ReasonCode | null, payload: unknown, adapterId: string | null = null, adapterVersion: string | null = null, assurance: "provider_verified" | "browser_observed" | "agent_assisted" | "prepared_only" = "browser_observed"): Promise<void> {
    await client.query("INSERT INTO shopping_audit_chain_heads(task_id) VALUES($1) ON CONFLICT DO NOTHING", [taskId]);
    const head = await client.query("SELECT * FROM shopping_audit_chain_heads WHERE task_id=$1 FOR UPDATE", [taskId]); const sequence = head.rows[0].sequence + 1; const previousHash = head.rows[0].hash; const createdAt = new Date().toISOString();
    const event = { taskId, buyerId, sequence, eventType, actor, reasonCode, adapterId, adapterVersion, evidenceAssurance: assurance, payload, previousHash, createdAt }; const hash = hashAuditPayload(previousHash, event);
    await client.query(`INSERT INTO shopping_audit_events(id,task_id,buyer_id,sequence,event_type,actor,reason_code,adapter_id,adapter_version,evidence_assurance,payload_json,previous_hash,hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [randomUUID(), taskId, buyerId, sequence, eventType, actor, reasonCode, adapterId, adapterVersion, assurance, payload, previousHash, hash, createdAt]);
    await client.query("UPDATE shopping_audit_chain_heads SET sequence=$2,hash=$3 WHERE task_id=$1", [taskId, sequence, hash]);
  }
}

function mapTask(row: any): ShoppingTask { return ShoppingTaskSchema.parse({ id: row.id, buyerId: row.buyer_id, site: row.site, query: row.query, productUrl: row.product_url, maxTotalPaise: row.max_total_paise, requireRefundable: row.require_refundable, minimumReturnWindowDays: row.minimum_return_window_days, latestDeliveryDate: row.latest_delivery_date, quantity: row.quantity, currency: row.currency, status: row.status, paymentPreference: row.payment_preference, allowedOrigin: row.allowed_origin, purchaseKind: row.purchase_kind, proposedCandidateId: row.proposed_candidate_id, selectionConfirmedAt: iso(row.selection_confirmed_at), selectedCandidateId: row.selected_candidate_id, purchasePermitId: row.purchase_permit_id, checkoutSnapshotHash: row.checkout_snapshot_hash, confirmedAt: iso(row.confirmed_at), denialReason: row.denial_reason, mode: row.mode, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }); }
function mapCandidate(row: any): ShoppingCandidate { return ShoppingCandidateSchema.parse({ id: row.id, taskId: row.task_id, canonicalProductId: row.canonical_product_id, listingId: row.listing_id, title: row.title, seller: row.seller, variant: row.variant, condition: row.condition, availability: row.availability, pricePaise: row.price_paise, currency: row.currency, productUrl: row.product_url, snapshotHash: row.snapshot_hash, observedAt: iso(row.observed_at), adapterId: row.adapter_id, adapterVersion: row.adapter_version, selected: row.selected, imageUrl: row.image_url, rating: row.rating === null || row.rating === undefined ? null : Number(row.rating), reviewCount: row.review_count, deliveryEstimate: row.delivery_estimate, rankingReasons: row.ranking_reasons_json ?? [], proposalSource: row.proposal_source ?? "recommended", queryMismatch: row.query_mismatch ?? false }); }
function mapProposal(row: any): ProductSelectionProposal { return ProductSelectionProposalSchema.parse({ id: row.id, taskId: row.task_id, candidateId: row.candidate_id, source: row.source, status: row.status, queryMismatch: row.query_mismatch, warning: row.warning, expiresAt: iso(row.expires_at), confirmedAt: iso(row.confirmed_at), createdAt: iso(row.created_at) }); }
function mapPermit(row: any): BrowserPurchasePermit { return BrowserPurchasePermitSchema.parse({ id: row.id, taskId: row.task_id, buyerId: row.buyer_id, checkoutSnapshot: row.checkout_snapshot_json, checkoutSnapshotHash: row.checkout_snapshot_hash, maxTotalPaise: row.max_total_paise, status: row.status, confirmedAt: iso(row.confirmed_at), expiresAt: iso(row.expires_at), idempotencyKey: row.idempotency_key, createdAt: iso(row.created_at) }); }
function mapAudit(row: any): ShoppingAuditEvent { return { id: row.id, taskId: row.task_id, buyerId: row.buyer_id, sequence: row.sequence, eventType: row.event_type, actor: row.actor, reasonCode: row.reason_code, adapterId: row.adapter_id, adapterVersion: row.adapter_version, evidenceAssurance: row.evidence_assurance, payload: row.payload_json, previousHash: row.previous_hash, hash: row.hash, createdAt: iso(row.created_at)! }; }
function auditMaterial(event: ShoppingAuditEvent) { return { taskId: event.taskId, buyerId: event.buyerId, sequence: event.sequence, eventType: event.eventType, actor: event.actor, reasonCode: event.reasonCode, adapterId: event.adapterId, adapterVersion: event.adapterVersion, evidenceAssurance: event.evidenceAssurance, payload: event.payload, previousHash: event.previousHash, createdAt: event.createdAt }; }
function iso(value: unknown): string | null { return value ? new Date(value as string | Date).toISOString() : null; }
function queryMatches(query: string, title: string): boolean { const terms = query.toLowerCase().match(/[a-z0-9]+/g)?.filter((term) => term.length > 2) ?? []; if (!terms.length) return true; const value = title.toLowerCase(); return terms.filter((term) => value.includes(term)).length / terms.length >= 0.5; }
