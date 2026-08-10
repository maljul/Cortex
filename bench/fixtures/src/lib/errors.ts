// Error types, mapped to status codes at the edge.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class BadRequest extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export class Unauthorized extends HttpError {
  constructor(message: string) {
    super(401, message);
  }
}

export class NotFound extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

export class Conflict extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

export class PaymentFailed extends HttpError {
  constructor(message: string) {
    super(402, message);
  }
}
