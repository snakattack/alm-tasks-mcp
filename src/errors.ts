export type ErrorCode =
  | 'CONFIG_ERROR' | 'INVALID_ARGUMENT' | 'AUTH_REQUIRED' | 'AUTH_FAILED'
  | 'NOT_FOUND' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'CRM_ERROR'
  | 'INVALID_RESPONSE' | 'NETWORK_ERROR' | 'OUTCOME_UNKNOWN'
  | 'ALREADY_SUBMITTED' | 'SUBMIT_NOT_AVAILABLE';

export class CrmError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CrmError';
  }

  toJSON(): { code: ErrorCode; message: string; status?: number } {
    return { code: this.code, message: this.message, ...(this.status === undefined ? {} : { status: this.status }) };
  }
}

export function asCrmError(error: unknown): CrmError {
  return error instanceof CrmError ? error : new CrmError('CRM_ERROR', 'Внутренняя ошибка интеграции.');
}
