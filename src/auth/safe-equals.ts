import { timingSafeEqual } from 'node:crypto';

/** 타이밍 공격을 피하는 문자열 비교 (API 키 대조용) */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
