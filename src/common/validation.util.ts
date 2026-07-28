import type { ValidationError } from 'class-validator';

/** rejected.message 상한 (docs/api.openapi.yaml — AI_RULES 27) */
export const MAX_ERROR_MESSAGE_LENGTH = 200;

/**
 * class-validator 오류 트리에서 첫 번째 제약 메시지를 뽑는다.
 * 기본 제약 메시지는 "속성명 + 규칙" 형태의 서버 정의 문구이며
 * 사용자 입력 값을 반사하지 않는다 (AI_RULES 27).
 */
export function firstConstraintMessage(errors: ValidationError[]): string {
  for (const error of errors) {
    if (error.constraints) {
      const messages = Object.values(error.constraints);
      if (messages.length > 0) {
        return messages[0].slice(0, MAX_ERROR_MESSAGE_LENGTH);
      }
    }
    if (error.children && error.children.length > 0) {
      const nested = firstConstraintMessage(error.children);
      if (nested !== DEFAULT_VALIDATION_MESSAGE) return nested;
    }
  }
  return DEFAULT_VALIDATION_MESSAGE;
}

export const DEFAULT_VALIDATION_MESSAGE = 'validation failed';
