import CryptoJS from 'crypto-js';
import { env } from '../config/env';

export function encrypt(plaintext: string): string {
  return CryptoJS.AES.encrypt(plaintext, env.ENCRYPTION_KEY).toString();
}

export function decrypt(ciphertext: string): string {
  const bytes = CryptoJS.AES.decrypt(ciphertext, env.ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

export function hashString(value: string): string {
  return CryptoJS.SHA256(value).toString();
}
