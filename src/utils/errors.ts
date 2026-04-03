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
  constructor(message: string, cause?: Error) {
    super(message, 'DETECTION_ERROR', cause);
    this.name = 'DetectionError';
  }
}

export class DatabaseError extends PalisadeError {
  constructor(message: string, cause?: Error) {
    super(message, 'DATABASE_ERROR', cause);
    this.name = 'DatabaseError';
  }
}
