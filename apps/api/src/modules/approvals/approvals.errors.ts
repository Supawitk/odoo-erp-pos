/**
 * Domain errors for the approvals (tier validation) module.
 *
 * Mapped to HTTP 422 by the global filter. Callers should let the error
 * bubble — never silently fall through, because that's how unapproved
 * refunds get posted.
 */
export class ApprovalRequiredError extends Error {
  readonly code = 'APPROVAL_REQUIRED';
  constructor(
    message: string,
    public readonly reviewIds: string[],
  ) {
    super(message);
    this.name = 'ApprovalRequiredError';
  }
}

export class ApprovalNotFoundError extends Error {
  readonly code = 'APPROVAL_NOT_FOUND';
  constructor(reviewId: string) {
    super(`tier review ${reviewId} not found`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalAlreadyResolvedError extends Error {
  readonly code = 'APPROVAL_ALREADY_RESOLVED';
  constructor(reviewId: string, status: string) {
    super(`tier review ${reviewId} already ${status}`);
    this.name = 'ApprovalAlreadyResolvedError';
  }
}

export class ApprovalForbiddenReviewerError extends Error {
  readonly code = 'APPROVAL_FORBIDDEN_REVIEWER';
  constructor(reviewId: string) {
    super(`user is not in the reviewer list for tier review ${reviewId}`);
    this.name = 'ApprovalForbiddenReviewerError';
  }
}
