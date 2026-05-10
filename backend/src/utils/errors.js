export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends HttpError {
  constructor(message, details) {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class NotFoundError extends HttpError {
  constructor(resource) {
    super(404, "NOT_FOUND", `${resource} not found`);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "forbidden", details) {
    super(403, "FORBIDDEN", message, details);
  }
}
