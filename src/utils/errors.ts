export class PalisadeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'PalisadeError';
  }
}

export class PolicyError extends PalisadeError {
  constructor(
    message: string,
    public readonly filePath?: string,
    public readonly validationErrors?: Array<{ path: string; message: string }>,
  ) {
    super(message, 'POLICY_ERROR');
    this.name = 'PolicyError';
  }
}

export class ProxyError extends PalisadeError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    cause?: Error,
  ) {
    super(message, 'PROXY_ERROR', cause);
    this.name = 'ProxyError';
  }
}

export class DetectionError extends PalisadeError {
  /**
   * Backward-compatible 3-way overload (BLOCKER 1). The historical signature was
   * `(message, cause?: Error)` and every existing caller in `src/detection/*` passes either no
   * second arg or an `Error` cause. To let the Tier 2 fast-fail throw a typed code
   * (`'tier2_model_missing'`) WITHOUT touching those callers, the second positional arg is now
   * `string | Error`:
   *   - `typeof codeOrCause === 'string'` → it is an explicit error code; `cause` is the 3rd arg.
   *   - otherwise → it is the Error cause (preserved verbatim) and the code stays `'DETECTION_ERROR'`.
   * The no-arg case keeps the default code with no cause.
   */
  constructor(message: string, codeOrCause?: string | Error, cause?: Error) {
    if (typeof codeOrCause === 'string') {
      super(message, codeOrCause, cause);
    } else {
      super(message, 'DETECTION_ERROR', codeOrCause);
    }
    this.name = 'DetectionError';
  }
}

export class DatabaseError extends PalisadeError {
  constructor(message: string, cause?: Error) {
    super(message, 'DATABASE_ERROR', cause);
    this.name = 'DatabaseError';
  }
}
