import { randomUUID } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Config } from "./config.js";
import { AgentRailError } from "./service.js";
import { AgentRailStore } from "./store.js";

export class AgentRailWebAuthn {
  constructor(readonly store: AgentRailStore, readonly config: Config) {}

  async registrationOptions(username: string, displayName: string) {
    if (await this.store.getUserByUsername(username)) throw new AgentRailError(409, "USERNAME_TAKEN", "That buyer username is already registered.");
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
    if (!challenge) throw new AgentRailError(409, "WEBAUTHN_CHALLENGE_INVALID", "The registration challenge expired or was already used.");
    let verification;
    try { verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.config.webauthnOrigin, expectedRPID: this.config.webauthnRpId, requireUserPresence: true, requireUserVerification: true }); }
    catch { throw new AgentRailError(400, "PASSKEY_VERIFICATION_FAILED", "The passkey registration response was invalid for this AgentRail origin."); }
    if (!verification.verified || !verification.registrationInfo.userVerified) throw new AgentRailError(400, "PASSKEY_VERIFICATION_FAILED", "The authenticator did not verify the user.");
    const info = verification.registrationInfo;
    const user = await this.store.createUserWithPasskey({ username: String(challenge.context.username), displayName: String(challenge.context.displayName), rpId: this.config.webauthnRpId, credentialId: info.credential.id, publicKey: info.credential.publicKey, counter: info.credential.counter, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, transports: response.response.transports ?? [] });
    return { verified: true, user };
  }

  async loginOptions(username: string) {
    const user = await this.store.getUserByUsername(username);
    if (!user) throw new AgentRailError(404, "ACCOUNT_NOT_FOUND", "No AgentRail account uses that username.");
    const credentials = await this.store.listPasskeys(user.id, this.config.webauthnRpId);
    if (!credentials.length) throw new AgentRailError(409, "PASSKEY_NOT_ENROLLED", "No passkey is enrolled for this AgentRail domain.");
    const options = await generateAuthenticationOptions({ rpID: this.config.webauthnRpId, timeout: 60_000, userVerification: "required", allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports as AuthenticatorTransportFuture[] })) });
    const challengeId = await this.store.createChallenge({ userId: user.id, purpose: "login", challenge: options.challenge });
    return { challengeId, options };
  }

  async verifyLogin(challengeId: string, response: AuthenticationResponseJSON) {
    const credential = await this.store.getPasskey(response.id, this.config.webauthnRpId);
    if (!credential) throw new AgentRailError(403, "UNKNOWN_PASSKEY", "This passkey is not enrolled for AgentRail.");
    const challenge = await this.store.consumeChallenge({ id: challengeId, purpose: "login", userId: credential.userId });
    if (!challenge) throw new AgentRailError(409, "WEBAUTHN_CHALLENGE_INVALID", "The login challenge expired or was already used.");
    const verification = await this.verifyAssertion(response, challenge.challenge, credential);
    await this.store.updatePasskeyCounter(credential.id, verification.authenticationInfo.newCounter);
    const user = await this.store.getUser(credential.userId);
    if (!user) throw new AgentRailError(403, "ACCOUNT_NOT_FOUND", "The passkey account is unavailable.");
    return { verified: true, user };
  }

  async approvalOptions(intentLockId: string, buyerId: string, sessionToken: string) {
    const intent = await this.store.getIntent(intentLockId, buyerId);
    if (!intent || intent.status !== "pending_confirmation" || new Date(intent.expiresAt).getTime() <= Date.now()) throw new AgentRailError(409, "INTENT_NOT_PENDING", "This IntentLock is not awaiting approval.");
    if (!await this.store.getApprovalSession(intentLockId, buyerId, sessionToken)) throw new AgentRailError(403, "APPROVAL_SESSION_INVALID", "The approval session is missing, expired, or already used.");
    const credentials = await this.store.listPasskeys(buyerId, this.config.webauthnRpId);
    if (!credentials.length) throw new AgentRailError(409, "PASSKEY_NOT_ENROLLED", "Enroll a passkey before approving this IntentLock.");
    const options = await generateAuthenticationOptions({ rpID: this.config.webauthnRpId, timeout: 60_000, userVerification: "required", allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports as AuthenticatorTransportFuture[] })) });
    const challengeId = await this.store.createChallenge({ userId: buyerId, intentLockId, purpose: "approval", challenge: options.challenge });
    return { challengeId, options };
  }

  async approve(intentLockId: string, buyerId: string, sessionToken: string, challengeId: string, response: AuthenticationResponseJSON) {
    const credential = await this.store.getPasskey(response.id, this.config.webauthnRpId);
    if (!credential || credential.userId !== buyerId) throw new AgentRailError(403, "UNKNOWN_PASSKEY", "This passkey does not belong to the IntentLock buyer.");
    const challenge = await this.store.consumeChallenge({ id: challengeId, purpose: "approval", userId: buyerId, intentLockId });
    if (!challenge) throw new AgentRailError(409, "WEBAUTHN_CHALLENGE_INVALID", "The approval challenge expired or was already used.");
    const verification = await this.verifyAssertion(response, challenge.challenge, credential);
    const intent = await this.store.completeApproval({ intentLockId, buyerId, sessionToken, credentialId: credential.id, counter: verification.authenticationInfo.newCounter, deviceType: verification.authenticationInfo.credentialDeviceType, backedUp: verification.authenticationInfo.credentialBackedUp });
    if (!intent) throw new AgentRailError(409, "APPROVAL_SESSION_INVALID", "The approval session was already consumed.");
    return intent;
  }

  private async verifyAssertion(response: AuthenticationResponseJSON, expectedChallenge: string, credential: { id: string; publicKey: Uint8Array; counter: number; transports: string[] }) {
    try {
      const verification = await verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: this.config.webauthnOrigin, expectedRPID: this.config.webauthnRpId, credential: { id: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter, transports: credential.transports as AuthenticatorTransportFuture[] }, requireUserVerification: true });
      if (!verification.verified || !verification.authenticationInfo.userVerified) throw new Error("User verification missing");
      return verification;
    } catch { throw new AgentRailError(400, "PASSKEY_VERIFICATION_FAILED", "The passkey assertion was invalid for this AgentRail origin."); }
  }
}
