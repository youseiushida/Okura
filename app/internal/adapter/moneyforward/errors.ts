import { PrimaryCredentialRejectedError } from "../../port/authentication.ts";
import { AuthenticationRequiredError } from "../../port/source.ts";

export class MoneyForwardError extends Error {
  override name = "MoneyForwardError";
}

export class AuthenticationFailedError extends PrimaryCredentialRejectedError {
  override name = "MoneyForwardAuthenticationFailedError";

  constructor(message = "Money Forward rejected the email or password") {
    super("moneyforward", message);
  }
}

export class VerificationFailedError extends MoneyForwardError {
  override name = "MoneyForwardVerificationFailedError";
}

export class UnauthenticatedError extends AuthenticationRequiredError {
  override name = "MoneyForwardUnauthenticatedError";

  constructor() {
    super("moneyforward", "Money Forward authentication is required");
  }
}

export class UnexpectedPageError extends MoneyForwardError {
  override name = "MoneyForwardUnexpectedPageError";
}

export class ParseError extends MoneyForwardError {
  override name = "MoneyForwardParseError";
}
