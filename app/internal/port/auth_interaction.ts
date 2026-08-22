import type { ProviderID } from "./provider.ts";

export type OtpChannel =
  | "sms"
  | "email"
  | "totp"
  | "voice";

export type OtpFormat =
  | "numeric"
  | "alphanumeric";

export interface OtpLengthConstraint {
  /**
   * 1以上。固定長の場合はminとmaxを同じ値にする。
   */
  readonly min: number;

  /**
   * min以上。
   */
  readonly max: number;
}

export type OtpResendPolicy =
  | {
    readonly allowed: false;
  }
  | {
    readonly allowed: true;

    /**
     * 再送可能になる日時。ISO 8601形式。
     * 直ちに再送できる場合は省略する。
     */
    readonly availableAt?: string;
  };

export interface OtpChallengeRequest {
  readonly provider: ProviderID;

  /**
   * provider内で安定した機械用ID。
   *
   * 例:
   * - transaction-approval-otp
   * - login-email-code
   */
  readonly step: string;

  /**
   * 同じstep内で1から始まる試行回数。
   */
  readonly attempt: number;

  readonly channel: OtpChannel;

  /**
   * 既にマスクされた送信先。
   * 生のメールアドレスや電話番号を渡してはいけない。
   */
  readonly destinationHint?: string;

  readonly format: OtpFormat;

  /**
   * providerから長さを判定できる場合だけ指定する。
   */
  readonly length?: OtpLengthConstraint;

  /**
   * コードの失効日時。ISO 8601形式。
   */
  readonly expiresAt?: string;

  /**
   * providerから取得できる場合だけ指定する。
   */
  readonly remainingAttempts?: number;

  readonly resend: OtpResendPolicy;
}

export type OtpChallengeReply =
  | {
    readonly action: "submit";
    readonly code: string;
  }
  | {
    readonly action: "resend";
  };

export interface AuthInteractionOptions {
  readonly signal?: AbortSignal;
}

/**
 * ユーザーからOTPの回答を得るPort。
 *
 * キャンセル時はreplyを返さず、signalをabortするか
 * AbortErrorをrejectする。
 */
export interface OtpChallengePort {
  request(
    challenge: OtpChallengeRequest,
    options?: AuthInteractionOptions,
  ): Promise<OtpChallengeReply>;
}

export type ExternalApprovalMethod =
  | "app"
  | "email-link"
  | "sms-link"
  | "qr";

export type AuthProgressEvent =
  | {
    readonly kind: "external-approval";
    readonly provider: ProviderID;
    readonly step: string;

    /**
     * required:
     *   初めてユーザー操作が必要になった。
     *
     * waiting:
     *   providerが承認結果をpollしている。
     *
     * completed:
     *   承認が完了した。
     */
    readonly state:
      | "required"
      | "waiting"
      | "completed";

    readonly method: ExternalApprovalMethod;

    /**
     * providerから得た文言を使う場合は、
     * 個人情報・HTML・制御文字を除去してから渡す。
     */
    readonly message?: string;

    /**
     * 承認要求の失効日時。ISO 8601形式。
     */
    readonly expiresAt?: string;
  }
  | {
    readonly kind: "code-sent";
    readonly provider: ProviderID;
    readonly step: string;
    readonly channel:
      | "sms"
      | "email"
      | "voice";
    readonly destinationHint?: string;
  };

/**
 * 認証進捗をUIへ通知するだけのPort。
 *
 * ユーザー回答を受け取ってはいけない。
 * provider側のpoll処理をこのPortへ移してはいけない。
 */
export interface AuthProgressPort {
  publish(
    event: AuthProgressEvent,
    options?: AuthInteractionOptions,
  ): Promise<void>;
}

/**
 * Okuraが対応する認証UI能力。
 *
 * 新しい認証方式が実際に必要になった時点で、
 * 専用Portを追加する。
 */
export interface AuthInteraction {
  readonly otp: OtpChallengePort;
  readonly progress: AuthProgressPort;
}
