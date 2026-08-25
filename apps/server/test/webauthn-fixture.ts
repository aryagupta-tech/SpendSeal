import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

export function createVirtualPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("P-256 JWK coordinates missing");
  const credentialId = Buffer.from("agentrail-virtual-passkey-credential");
  const credentialIdString = credentialId.toString("base64url");
  const cosePublicKey = isoCBOR.encode(new Map<number, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]) as never);

  function registrationResponse(options: PublicKeyCredentialCreationOptionsJSON, origin: string, rpId: string): RegistrationResponseJSON {
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const rpIdHash = createHash("sha256").update(rpId).digest();
    const counter = Buffer.alloc(4);
    const credentialLength = Buffer.alloc(2);
    credentialLength.writeUInt16BE(credentialId.length);
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x45]), counter, Buffer.alloc(16), credentialLength, credentialId, Buffer.from(cosePublicKey)]);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authenticatorData]]) as never);
    return {
      id: credentialIdString,
      rawId: credentialIdString,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
        transports: ["internal"],
        publicKeyAlgorithm: -7,
      },
    };
  }

  function authenticationResponse(options: PublicKeyCredentialRequestOptionsJSON, input: { origin: string; rpId: string; userVerified?: boolean; credentialId?: string; challenge?: string; counter?: number }): AuthenticationResponseJSON {
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: input.challenge ?? options.challenge, origin: input.origin, crossOrigin: false }));
    const rpIdHash = createHash("sha256").update(input.rpId).digest();
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(input.counter ?? 1);
    const flags = input.userVerified === false ? 0x01 : 0x05;
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
    const clientDataHash = createHash("sha256").update(clientData).digest();
    const signature = sign("sha256", Buffer.concat([authenticatorData, clientDataHash]), privateKey);
    const id = input.credentialId ?? credentialIdString;
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
        signature: isoBase64URL.fromBuffer(signature),
      },
    };
  }

  return { credentialId: credentialIdString, registrationResponse, authenticationResponse };
}
