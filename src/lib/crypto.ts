import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * 字段级对称加密（AES-256-GCM）。用于 services.credentials 等机密字段。
 * 密钥：从 AUTH_SECRET + 固定 salt 通过 scrypt 派生 32 字节；进程内缓存。
 * 密文格式：`enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>`；未加密旧数据保持原样直接返回。
 */

const VERSION = "v1";
const PREFIX = `enc:${VERSION}:`;
const SALT = Buffer.from("server-nav-field-v1", "utf8");

let _key: Buffer | null = null;
function getKey(): Buffer {
  if (_key) return _key;
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 8) {
    throw new Error("AUTH_SECRET 未配置或过短，无法进行字段加密");
  }
  _key = scryptSync(secret, SALT, 32);
  return _key;
}

/** 加密明文字符串（非 null）。已是密文则原样返回，幂等。 */
export function encryptField(plain: string): string {
  if (typeof plain !== "string") return plain;
  if (plain.startsWith(PREFIX)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/** 解密字段；若不是密文（兼容旧数据），原样返回。 */
export function decryptField(value: string): string {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
  const body = value.slice(PREFIX.length);
  const [ivB64, tagB64, ctB64] = body.split(":");
  if (!ivB64 || !tagB64 || !ctB64) return value;
  try {
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    // 解密失败（密钥变更 / 数据损坏）——返回原始值，避免整站 500
    return value;
  }
}

export function encryptOrNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  return encryptField(v);
}

export function decryptOrNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return decryptField(v);
}

export const CREDENTIAL_PREFIX = PREFIX;
