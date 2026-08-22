export class AmazonError extends Error {
  override name = "AmazonError";
}

export class AuthenticationFailedError extends AmazonError {
  override name = "AmazonAuthenticationFailedError";

  constructor(message = "Amazon authentication failed") {
    super(message);
  }
}

export class VerificationRequiredError extends AmazonError {
  override name = "AmazonVerificationRequiredError";

  constructor(message = "Amazon verification is required") {
    super(message);
  }
}

export class UnauthenticatedError extends AmazonError {
  override name = "AmazonUnauthenticatedError";

  constructor() {
    super("Amazon session is not authenticated; run login first");
  }
}

export class UnexpectedPageError extends AmazonError {
  override name = "AmazonUnexpectedPageError";
}
