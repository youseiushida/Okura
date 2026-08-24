export interface TurnstileChallenge {
  readonly pageURL: string;
  readonly siteKey: string;
  readonly action?: string;
  readonly cData?: string;
  readonly chlPageData?: string;
}

export interface TurnstileSolution {
  /** Cloudflare Turnstileの使い捨てtoken。永続化してはいけない。 */
  readonly token: string;

  /** token生成時にsolverが使用したUser-Agent。token送信時にも使用する。 */
  readonly userAgent: string;
}

export interface TurnstileSolverOptions {
  readonly signal?: AbortSignal;
}

/** Turnstile challengeを外部の解決手段へ委譲するPort。 */
export interface TurnstileSolverPort {
  solve(
    challenge: TurnstileChallenge,
    options?: TurnstileSolverOptions,
  ): Promise<TurnstileSolution>;
}
