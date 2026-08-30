import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  BrowserPurchasePermitSchema,
  CheckoutObservationSchema,
  CreateShoppingTaskInputSchema,
  ShoppingCandidateSchema,
  ShoppingTaskSchema,
  allowedShoppingHost,
  checkoutSnapshotHash,
  evaluateBrowserCheckout,
  hashAuditPayload,
  sha256,
  type BrowserPurchasePermit,
  type CheckoutObservation,
  type CreateShoppingTaskInput,
  type ReasonCode,
  type ShoppingCandidate,
  type ShoppingTask,
} from "@spendseal/core";
import { transaction } from "./db/client.js";

export type BrowserPrincipal = { userId: string; clientId: string; scopes: string[] };
export type ShoppingAuditEvent = {
  id: string; taskId: string; buyerId: string; sequence: number; eventType: string; actor: string; reasonCode: ReasonCode | null;
  adapterId: string | null; adapterVersion: string | null; evidenceAssurance: "browser_observed" | "prepared_only";
  payload: unknown; previousHash: string; hash: string; createdAt: string;
};
export type BrowserExecutionResult = {
  executionGrant: string;
  status: "completed" | "user_action_required" | "reconciliation_required" | "failed";
  detail?: string;
};

export class BrowserAgentService {
  constructor(private readonly pool: Pool, private readonly livePurchaseEnabled = false, private readonly enabled = true) {}
  get liveModeEnabled(): boolean { return this.enabled && this.livePurchaseEnabled; }

  async createTask(buyerId: string, raw: CreateShoppingTaskInput): Promise<ShoppingTask> {
    this.ensureEnabled();
    const input = CreateShoppingTaskInputSchema.parse(raw);
    return transaction(this.pool, async (client) => {
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString();
      const mode = this.livePurchaseEnabled ? "live" : "prepare_only";
      const result = await client.query(`INSERT INTO shopping_tasks(id,buyer_id,site,query,product_url,max_total_paise,require_refundable,minimum_return_window_days,latest_delivery_date,status,mode,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting_for_extension',$10,$11) RETURNING *`,
      [id, buyerId, input.site, input.query ?? null, input.productUrl ?? null, input.maxTotalPaise, input.requireRefundable, input.minimumReturnWindowDays, input.latestDeliveryDate, mode, expiresAt]);
      await this.appendAudit(client, id, buyerId, "SHOPPING_TASK_CREATED", "chatgpt", null, { site: input.site, query: input.query ?? null, productUrl: input.productUrl ?? null, maxTotalPaise: input.maxTotalPaise, mode });
      return mapTask(result.rows[0]);
    });
  }

  async getTask(taskId: string, buyerId: string): Promise<{ task: ShoppingTask; candidates: ShoppingCandidate[]; permit: BrowserPurchasePermit | null }> {
    this.ensureEnabled();
    const [taskResult, candidatesResult, permitResult] = await Promise.all([
      this.pool.query("SELECT * FROM shopping_tasks WHERE id=$1 AND buyer_id=$2", [taskId, buyerId]),
      this.pool.query("SELECT * FROM shopping_candidates WHERE task_id=$1 ORDER BY created_at LIMIT 3", [taskId]),
      this.pool.query("SELECT * FROM browser_purchase_permits WHERE task_id=$1 AND buyer_id=$2", [taskId, buyerId]),
    ]);
    if (!taskResult.rows[0]) throw new Error("SHOPPING_TASK_NOT_FOUND");
    return { task: mapTask(taskResult.rows[0]), candidates: candidatesResult.rows.map(mapCandidate), permit: permitResult.rows[0] ? mapPermit(permitResult.rows[0]) : null };
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
      if (candidates.some((candidate) => candidate.adapterId !== task.site || !allowedShoppingHost(task.site, candidate.productUrl))) {
        throw new Error("DOMAIN_MISMATCH");
      }
      await client.query("DELETE FROM shopping_candidates WHERE task_id=$1", [taskId]);
      const saved: ShoppingCandidate[] = [];
      for (const candidate of candidates) {
        const id = randomUUID();
        const result = await client.query(`INSERT INTO shopping_candidates(id,task_id,canonical_product_id,listing_id,title,seller,variant,condition,availability,price_paise,currency,product_url,snapshot_hash,observed_at,adapter_id,adapter_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [id, taskId, candidate.canonicalProductId, candidate.listingId, candidate.title, candidate.seller, candidate.variant, candidate.condition, candidate.availability, candidate.pricePaise, candidate.currency, candidate.productUrl, candidate.snapshotHash, candidate.observedAt, candidate.adapterId, candidate.adapterVersion]);
        saved.push(mapCandidate(result.rows[0]));
      }
      await client.query("UPDATE shopping_tasks SET status='selection_required',updated_at=now() WHERE id=$1", [taskId]);
      await client.query(`INSERT INTO browser_observations(id,task_id,installation_id,kind,adapter_id,adapter_version,source_url,snapshot_json,snapshot_hash,observed_at)
        VALUES($1,$2,$3,'candidates',$4,$5,$6,$7,$8,$9)`, [randomUUID(), taskId, installationId, candidates[0]!.adapterId, candidates[0]!.adapterVersion, candidates[0]!.productUrl, JSON.stringify(saved), sha256(saved), candidates[0]!.observedAt]);
      await this.appendAudit(client, taskId, buyerId, "CANDIDATES_OBSERVED", "browser_extension", null, { count: saved.length }, candidates[0]!.adapterId, candidates[0]!.adapterVersion);
      return saved;
    });
  }

  async selectCandidate(taskId: string, buyerId: string, candidateId: string): Promise<ShoppingTask> {
    this.ensureEnabled();
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId);
      if (task.status !== "selection_required") throw new Error("TASK_STATE_INVALID");
      const candidate = await client.query("SELECT * FROM shopping_candidates WHERE id=$1 AND task_id=$2", [candidateId, taskId]);
      if (!candidate.rows[0]) throw new Error("CANDIDATE_NOT_FOUND");
      await client.query("UPDATE shopping_candidates SET selected=(id=$2) WHERE task_id=$1", [taskId, candidateId]);
      const result = await client.query("UPDATE shopping_tasks SET selected_candidate_id=$2,status='navigating',updated_at=now() WHERE id=$1 RETURNING *", [taskId, candidateId]);
      await this.appendAudit(client, taskId, buyerId, "CANDIDATE_SELECTED", "buyer", null, { candidateId, canonicalProductId: candidate.rows[0].canonical_product_id });
      return mapTask(result.rows[0]);
    });
  }

  async reportStatus(taskId: string, buyerId: string, installationId: string, status: "searching" | "navigating" | "user_action_required" | "failed", detail?: string): Promise<void> {
    this.ensureEnabled();
    await transaction(this.pool, async (client) => {
      await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      await client.query("UPDATE shopping_tasks SET status=$2,updated_at=now() WHERE id=$1", [taskId, status]);
      await this.appendAudit(client, taskId, buyerId, status === "user_action_required" ? "USER_ACTION_REQUIRED" : "BROWSER_PROGRESS", "browser_extension", status === "user_action_required" ? "USER_ACTION_REQUIRED" : null, { status, detail: detail?.slice(0, 240) ?? null });
    });
  }

  async observeCheckout(taskId: string, buyerId: string, installationId: string, raw: unknown): Promise<{ task: ShoppingTask; permit: BrowserPurchasePermit | null; allowed: boolean; reasons: ReasonCode[] }> {
    this.ensureEnabled();
    const observation = CheckoutObservationSchema.parse(raw);
    return transaction(this.pool, async (client) => {
      const task = await this.lockTask(client, taskId, buyerId); await this.assertInstallation(client, installationId, buyerId);
      if (!task.selectedCandidateId || !["navigating", "checkout_observed", "pending_approval"].includes(task.status)) throw new Error("TASK_STATE_INVALID");
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

  async claimExecution(taskId: string, buyerId: string, installationId: string, raw: unknown): Promise<{ status: "prepared" | "submitting" | "denied"; reason?: ReasonCode; executionGrant?: string }> {
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
      const attemptId = randomUUID();
      if (task.mode === "prepare_only") {
        await client.query("INSERT INTO browser_execution_attempts(id,task_id,installation_id,status,outcome_json) VALUES($1,$2,$3,'prepared',$4)", [attemptId, taskId, installationId, { submitted: false, reason: "showcase_prepare_only" }]);
        await client.query("UPDATE shopping_tasks SET status='prepared',updated_at=now() WHERE id=$1", [taskId]);
        await client.query("UPDATE browser_purchase_permits SET status='prepared' WHERE id=$1", [permit.id]);
        await this.appendAudit(client, taskId, buyerId, "PURCHASE_PREPARED", "browser_extension", null, { liveOrderSubmitted: false }, observation.adapterId, observation.adapterVersion, "prepared_only");
        return { status: "prepared" };
      }
      if (!this.livePurchaseEnabled) {
        await this.appendAudit(client, taskId, buyerId, "POLICY_DENIED", "policy_engine", "LIVE_PURCHASE_DISABLED", { liveOrderSubmitted: false }, observation.adapterId, observation.adapterVersion);
        return { status: "denied", reason: "LIVE_PURCHASE_DISABLED" };
      }
      const grant = randomBytes(32).toString("base64url");
      await client.query("INSERT INTO browser_execution_attempts(id,task_id,installation_id,grant_token_hash,grant_expires_at,status) VALUES($1,$2,$3,$4,now()+interval '2 minutes','claimed')", [attemptId, taskId, installationId, sha256(grant)]);
      await client.query("UPDATE shopping_tasks SET status='submitting',updated_at=now() WHERE id=$1", [taskId]);
      await client.query("UPDATE browser_purchase_permits SET status='submitting' WHERE id=$1", [permit.id]);
      return { status: "submitting", executionGrant: grant };
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
  private async appendAudit(client: PoolClient, taskId: string, buyerId: string, eventType: string, actor: string, reasonCode: ReasonCode | null, payload: unknown, adapterId: string | null = null, adapterVersion: string | null = null, assurance: "browser_observed" | "prepared_only" = "browser_observed"): Promise<void> {
    await client.query("INSERT INTO shopping_audit_chain_heads(task_id) VALUES($1) ON CONFLICT DO NOTHING", [taskId]);
    const head = await client.query("SELECT * FROM shopping_audit_chain_heads WHERE task_id=$1 FOR UPDATE", [taskId]); const sequence = head.rows[0].sequence + 1; const previousHash = head.rows[0].hash; const createdAt = new Date().toISOString();
    const event = { taskId, buyerId, sequence, eventType, actor, reasonCode, adapterId, adapterVersion, evidenceAssurance: assurance, payload, previousHash, createdAt }; const hash = hashAuditPayload(previousHash, event);
    await client.query(`INSERT INTO shopping_audit_events(id,task_id,buyer_id,sequence,event_type,actor,reason_code,adapter_id,adapter_version,evidence_assurance,payload_json,previous_hash,hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [randomUUID(), taskId, buyerId, sequence, eventType, actor, reasonCode, adapterId, adapterVersion, assurance, payload, previousHash, hash, createdAt]);
    await client.query("UPDATE shopping_audit_chain_heads SET sequence=$2,hash=$3 WHERE task_id=$1", [taskId, sequence, hash]);
  }
}

function mapTask(row: any): ShoppingTask { return ShoppingTaskSchema.parse({ id: row.id, buyerId: row.buyer_id, site: row.site, query: row.query, productUrl: row.product_url, maxTotalPaise: row.max_total_paise, requireRefundable: row.require_refundable, minimumReturnWindowDays: row.minimum_return_window_days, latestDeliveryDate: row.latest_delivery_date, quantity: row.quantity, currency: row.currency, status: row.status, selectedCandidateId: row.selected_candidate_id, purchasePermitId: row.purchase_permit_id, checkoutSnapshotHash: row.checkout_snapshot_hash, confirmedAt: iso(row.confirmed_at), denialReason: row.denial_reason, mode: row.mode, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }); }
function mapCandidate(row: any): ShoppingCandidate { return ShoppingCandidateSchema.parse({ id: row.id, taskId: row.task_id, canonicalProductId: row.canonical_product_id, listingId: row.listing_id, title: row.title, seller: row.seller, variant: row.variant, condition: row.condition, availability: row.availability, pricePaise: row.price_paise, currency: row.currency, productUrl: row.product_url, snapshotHash: row.snapshot_hash, observedAt: iso(row.observed_at), adapterId: row.adapter_id, adapterVersion: row.adapter_version, selected: row.selected }); }
function mapPermit(row: any): BrowserPurchasePermit { return BrowserPurchasePermitSchema.parse({ id: row.id, taskId: row.task_id, buyerId: row.buyer_id, checkoutSnapshot: row.checkout_snapshot_json, checkoutSnapshotHash: row.checkout_snapshot_hash, maxTotalPaise: row.max_total_paise, status: row.status, confirmedAt: iso(row.confirmed_at), expiresAt: iso(row.expires_at), idempotencyKey: row.idempotency_key, createdAt: iso(row.created_at) }); }
function mapAudit(row: any): ShoppingAuditEvent { return { id: row.id, taskId: row.task_id, buyerId: row.buyer_id, sequence: row.sequence, eventType: row.event_type, actor: row.actor, reasonCode: row.reason_code, adapterId: row.adapter_id, adapterVersion: row.adapter_version, evidenceAssurance: row.evidence_assurance, payload: row.payload_json, previousHash: row.previous_hash, hash: row.hash, createdAt: iso(row.created_at)! }; }
function auditMaterial(event: ShoppingAuditEvent) { return { taskId: event.taskId, buyerId: event.buyerId, sequence: event.sequence, eventType: event.eventType, actor: event.actor, reasonCode: event.reasonCode, adapterId: event.adapterId, adapterVersion: event.adapterVersion, evidenceAssurance: event.evidenceAssurance, payload: event.payload, previousHash: event.previousHash, createdAt: event.createdAt }; }
function iso(value: unknown): string | null { return value ? new Date(value as string | Date).toISOString() : null; }
