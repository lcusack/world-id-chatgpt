import type { SealedValue } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function randomToken(byteLength = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(secret);
  if (bytes.byteLength !== 32) throw new Error("DATA_ENCRYPTION_KEY must contain 32 bytes");
  return crypto.subtle.importKey("raw", arrayBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealJson(value: unknown, secret: string): Promise<SealedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importAesKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return {
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    iv: bytesToBase64Url(iv),
  };
}

export async function openJson<T>(sealed: SealedValue, secret: string): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: arrayBuffer(base64UrlToBytes(sealed.iv)) },
    await importAesKey(secret),
    arrayBuffer(base64UrlToBytes(sealed.ciphertext)),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export async function hmacSubject(sessionId: string, secret: string): Promise<string> {
  const keyBytes = base64UrlToBytes(secret);
  if (keyBytes.byteLength !== 32) throw new Error("SUBJECT_HMAC_KEY must contain 32 bytes");
  const key = await crypto.subtle.importKey("raw", arrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`world-id-session:${sessionId}`));
  return `wid_${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function importRootHmacKey(secret: string): Promise<CryptoKey> {
  const keyBytes = base64UrlToBytes(secret);
  if (keyBytes.byteLength !== 32) throw new Error("HMAC secret must contain 32 bytes");
  return crypto.subtle.importKey("raw", arrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function partnerSubject(subjectId: string, partnerId: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importRootHmacKey(secret),
    encoder.encode(`world-id-partner-subject:v1:${partnerId}:${subjectId}`),
  );
  return `hps_${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function signPartnerAssertion(payload: string, partnerSecret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importRootHmacKey(partnerSecret),
    encoder.encode(`world-id-human-grant:v1:${payload}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyPartnerAssertion(payload: string, signature: string, partnerSecret: string): Promise<boolean> {
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    await importRootHmacKey(partnerSecret),
    arrayBuffer(signatureBytes),
    encoder.encode(`world-id-human-grant:v1:${payload}`),
  );
}

async function importReceiptKey(secret: string): Promise<CryptoKey> {
  const keyBytes = base64UrlToBytes(secret);
  if (keyBytes.byteLength !== 32) throw new Error("SUBJECT_HMAC_KEY must contain 32 bytes");
  const keyMaterial = await crypto.subtle.importKey("raw", arrayBuffer(keyBytes), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("world-id-chatgpt:receipt-key:v1"),
      info: encoder.encode("human-approved-intent-receipts"),
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function signReceipt(payload: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await importReceiptKey(secret), encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyReceiptSignature(payload: string, signature: string, secret: string): Promise<boolean> {
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    await importReceiptKey(secret),
    arrayBuffer(signatureBytes),
    encoder.encode(payload),
  );
}

export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
