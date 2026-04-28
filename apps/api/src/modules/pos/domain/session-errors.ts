import { DomainError } from './errors';

export class SessionAlreadyOpenError extends DomainError {
  constructor(userId: string, existingSessionId: string) {
    super(
      'SESSION_ALREADY_OPEN',
      `User ${userId} already has an open session ${existingSessionId}. Close it before opening a new one.`,
    );
  }
}

export class SessionNotFoundError extends DomainError {
  constructor(id: string) {
    super('SESSION_NOT_FOUND', `POS session ${id} not found`);
  }
}

export class SessionAlreadyClosedError extends DomainError {
  constructor(id: string, status: string) {
    super('SESSION_ALREADY_CLOSED', `POS session ${id} is already ${status}`);
  }
}

export class VarianceRequiresApprovalError extends DomainError {
  constructor(varianceCents: number, thresholdCents: number) {
    super(
      'VARIANCE_REQUIRES_APPROVAL',
      `Variance ${varianceCents} cents exceeds auto-accept threshold ${thresholdCents} cents — manager approval required`,
    );
  }
}
