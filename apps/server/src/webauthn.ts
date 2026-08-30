import { randomUUID } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Config } from "./config.js";
import { SpendSealError } from "./service.js";
import { SpendSealStore } from "./store.js";
import { BrowserAgentService } from "./browser-agent.js";

export class SpendSealWebAuthn {
  constructor(readonly store: SpendSealStore, readonly config: Config, readonly browserAgent?: BrowserAgentService) {}

  async registrationOptions(username: string, displayName: string) {
    if (await this.store.getUserByUsername(username)) throw new SpendSealError(409, "USERNAME_TAKEN", "That buyer username is already registered.");
    const pendingUserId = randomUUID();
    const options = await generateRegistrationOptions({
      rpName: this.config.webauthnRpName, rpID: this.config.webauthnRpId, userID: new TextEncoder().encode(pendingUserId), userName: username.toLowerCase(), userDisplayName: displayName,
      attestationType: "none", timeout: 60_000, authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, preferredAuthenticatorType: "localDevice",
    });
    const challengeId = await this.store.createChallenge({ purpose: "registration", challenge: options.challenge, context: { username: username.toLowerCase(), displayName, pendingUserId } });
    return { challengeId, options };
  }

  async verifyRegistration(challengeId: string, response: RegistrationResponseJSON) {
    const challenge = await this.store.consumeChallenge({ id: challengeId, purpose: "registration" });
    if (!challenge) throw new SpendSealError(409, "WEBAUTHN_CHALLENGE_INVALID", "The registration challenge expired or was already used.");
    let verification;
    try { verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.config.webauthnOrigin, expectedRPID: this.config.webauthnRpId, requireUserPresence: true, requireUserVerification: true }); }
    catch { throw new SpendSealError(400, "PASSKEY_VERIFICATION_FAILED", "The passkey registration response was invalid for this SpendSeal origin."); }
    if (!verification.verified || !verification.registrationInfo.userVerified) throw new SpendSealError(400, "PASSKEY_VERIFICATION_FAILED", "The authenticator did not verify the user.");
    const info = verification.registrationInfo;
    const user = await this.store.createUserWithPasskey({ username: String(challenge.context.username), displayName: String(challenge.context.displayName), rpId: this.config.webauthnRpId, credentialId: info.credential.id, publicKey: info.credential.publicKey, counter: info.credential.counter, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, transports: response.response.transports ?? [] });
    return { verified: true, user };
  }

  async loginOptions(username: string) {
    const user = await this.store.getUserByUsername(username);
    if (!user) throw new SpendSealError(404, "ACCOUNT_NOT_FOUND", "No SpendSeal account uses that username.");
    const credentials = await this.store.listPasskeys(user.id, this.config.webauthnRpId);
    if (!credentials.length) throw new SpendSealError(409, "PASSKEY_NOT_ENROLLED", "No passkey is enrolled for this SpendSeal domain.");
    const options = await generateAuthenticationOptions({ rpID: this.config.webauthnRpId, timeout: 60_000, userVerification: "required", allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports as AuthenticatorTransportFuture[] })) });
    const challengeId = await this.store.createChallenge({ userId: user.id, purpose: "login", challenge: options.challenge });
    return { challengeId, options };
  }

  async verifyLogin(challengeId: string, response: AuthenticationResponseJSON) {
    const credential = await this.store.getPasskey(response.id, this.config.webauthnRpId);
    if (!credential) throw new SpendSealError(403, "UNKNOWN_PASSKEY", "This passkey is not enrolled for SpendSeal.");
    const challenge = await this.store.consumeChallenge({ id: challengeId, purpose: "login", userId: credential.userId });
    if (!challenge) throw new SpendSealError(409, "WEBAUTHN_CHALLENGE_INVALID", "The login challenge expired or was already used.");
    const verification = await this.verifyAssertion(response, challenge.challenge, credential);
    await this.store.updatePasskeyCounter(credential.id, verification.authenticationInfo.newCounter);
    const user = await this.store.getUser(credential.userId);
    if (!user) throw new SpendSealError(403, "ACCOUNT_NOT_FOUND", "The passkey account is unavailable.");
    return { verified: true, user };
  }

  async approvalOptions(purchasePermitId: string, buyerId: string, sessionToken: string) {
    const intent = await this.store.getIntent(purchasePermitId, buyerId);
    if (!intent || intent.status !== "pending_confirmation" || new Date(intent.expiresAt).getTime() <= Date.now()) throw new SpendSealError(409, "INTENT_NOT_PENDING", "This PurchasePermit is not awaiting approval.");
    if (!await this.store.getApprovalSession(purchasePermitId, buyerId, sessionToken)) throw new SpendSealError(403, "APPROVAL_SESSION_INVALID", "The approval session is missing, expired, or already used.");
    const credentials = await this.store.listPasskeys(buyerId, this.config.webauthnRpId);
    if (!credentials.length) throw new SpendSealError(409, "PASSKEY_NOT_ENROLLED", "Enroll a passkey before approving this PurchasePermit.");
    const options = await generateAuthenticationOptions({ rpID: this.config.webauthnRpId, timeout: 60_000, userVerification: "required", allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports as AuthenticatorTransportFuture[] })) });
    const challengeId = await this.store.createChallenge({ userId: buyerId, purchasePermitId, purpose: "approval", challenge: options.challenge });
    return { challengeId, options };
  }

  async approve(purchasePermitId: string, buyerId: string, sessionToken: string, challengeId: string, response: AuthenticationResponseJSON) {
    const credential = await this.store.getPasskey(response.id, this.config.webauthnRpId);
    if (!credential || credential.userId !== buyerId) throw new SpendSealError(403, "UNKNOWN_PASSKEY", "This passkey does not belong to the PurchasePermit buyer.");
    const challenge = await this.store.consumeChallenge({ id: challengeId, purpose: "approval", userId: buyerId, purchasePermitId });
    if (!challenge) throw new SpendSealError(409, "WEBAUTHN_CHALLENGE_INVALID", "The approval challenge expired or was already used.");
    const verification = await this.verifyAssertion(response, challenge.challenge, credential);
    const intent = await this.store.completeApproval({ purchasePermitId, buyerId, sessionToken, credentialId: credential.id, counter: verification.authenticationInfo.newCounter, deviceType: verification.authenticationInfo.credentialDeviceType, backedUp: verification.authenticationInfo.credentialBackedUp });
    if (!intent) throw new SpendSealError(409, "APPROVAL_SESSION_INVALID", "The approval session was already consumed.");
    return intent;
  }

  async shoppingApprovalOptions(taskId: string, buyerId: string) {
    if (!this.browserAgent) throw new SpendSealError(404, "BROWSER_AGENT_DISABLED", "Browser purchasing is unavailable.");
    const { task, permit } = await this.browserAgent.getTask(taskId, buyerId);
    if (task.status !== "pending_approval" || !permit || permit.status !== "pending_confirmation" || new Date(permit.expiresAt).getTime() <= Date.now()) throw new SpendSealError(409, "TASK_NOT_PENDING", "This Shopping Task is not awaiting approval.");
    const credentials = await this.store.listPasskeys(buyerId, this.config.webauthnRpId);
    if (!credentials.length) throw new SpendSealError(409, "PASSKEY_NOT_ENROLLED", "Enroll a passkey before approving this Purchase Seal.");
    const options = await generateAuthenticationOptions({ rpID: this.config.webauthnRpId, timeout: 60_000, userVerification: "required", allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports as AuthenticatorTransportFuture[] })) });
    const challengeId = await this.store.createChallenge({ userId: buyerId, shoppingTaskId: taskId, purpose: "shopping_approval", challenge: options.challenge });
    return { challengeId, options };
  }

  async approveShoppingTask(taskId: string, buyerId: string, challengeId: string, response: AuthenticationResponseJSON) {
    if (!this.browserAgent) throw new SpendSealError(404, "BROWSER_AGENT_DISABLED", "Browser purchasing is unavailable.");
    const credential = await this.store.getPasskey(response.id, this.config.webauthnRpId);
    if (!credential || credential.userId !== buyerId) throw new SpendSealError(403, "UNKNOWN_PASSKEY", "This passkey does not belong to the Shopping Task buyer.");
    const challenge = await this.store.consumeChallenge({ id: challengeId, purpose: "shopping_approval", userId: buyerId, shoppingTaskId: taskId });
    if (!challenge) throw new SpendSealError(409, "WEBAUTHN_CHALLENGE_INVALID", "The approval challenge expired or was already used.");
    const verification = await this.verifyAssertion(response, challenge.challenge, credential);
    await this.store.updatePasskeyCounter(credential.id, verification.authenticationInfo.newCounter);
    return this.browserAgent.approve(taskId, buyerId);
  }

  private async verifyAssertion(response: AuthenticationResponseJSON, expectedChallenge: string, credential: { id: string; publicKey: Uint8Array; counter: number; transports: string[] }) {
    try {
      const verification = await verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: this.config.webauthnOrigin, expectedRPID: this.config.webauthnRpId, credential: { id: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter, transports: credential.transports as AuthenticatorTransportFuture[] }, requireUserVerification: true });
      if (!verification.verified || !verification.authenticationInfo.userVerified) throw new Error("User verification missing");
      return verification;
    } catch { throw new SpendSealError(400, "PASSKEY_VERIFICATION_FAILED", "The passkey assertion was invalid for this SpendSeal origin."); }
  }
}
