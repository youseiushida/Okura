# Okura 開発ガイド

この文書は、ネットショッピング、クレジットカード、銀行、電子マネー、家計簿サービスなど、
新しい対応サイトを追加するときの設計規則と実装手順を定める。

## 最優先の設計規則

OkuraはClean Architectureと依存性逆転を採用する。依存方向は必ず次の向きに保つ。

```text
CLI ────────> Application ────────> Ports / Models
                    ^                    ^
                    |                    |
Composition Root ───┴──> Adapters ──────┘
```

許可される依存は次のとおり。

- `internal/model/`: 他の内部層へ依存しない。
- `internal/port/`: `model/` にだけ依存してよい。
- `internal/application/`: `port/`、`model/`、同じapplication serviceに依存してよい。
- `internal/adapter/`: `port/`、`model/`、`http/`、`error/` に依存してよい。
- `internal/cli/`: application use case、port、model、CLI内の部品に依存してよい。
- `internal/cli/default_environment.ts`: composition rootとして、applicationと具体adapterの両方に依存してよい。

次の依存は禁止する。

- modelまたはportからapplication、adapter、CLIをimportしない。
- applicationから具体adapterまたはCLIをimportしない。
- `default_environment.ts` 以外のCLIから具体adapterをimportしない。
- CLIの公開境界に `JCBModule` のような具体adapterの型を露出しない。
- あるproviderのadapterから別providerのadapterをimportしない。
- provider共通化を理由に、adapter固有の概念をportやmodelへ押し込まない。
- 認証、セッション復元、複数source取得、結果整合性検証をCLIに実装しない。

共通化する場所は責務で決める。

- 金融データの概念とidentityは `model/`。
- adapterが実装する契約は `port/`。
- 認証と取得の手順は `application/`。
- Cookie、redirect、response sizeなどHTTP共通処理は `http/`。
- サイト固有のURL、HTML、API、認証状態、parserはそのproviderのadapter内。
- 具体部品の生成とuse caseへの接続はcomposition rootだけ。

## 安定したディレクトリ境界

```text
app/internal/
├── model/          金融データとconnection identity
├── port/           認証、source、session vaultの抽象
├── application/    認証調停と取得use case
├── adapter/
│   ├── <provider>/  providerごとに閉じた実装
│   └── session/     session永続化adapter
├── cli/            引数、入力、表示、routing
├── http/           安全なHTTP sessionとbody制限
├── error/          共通エラー補助
└── testing/        複数層で共有するテストfixture
```

最初に次を読む。

- `internal/port/source.ts`: providerが提供できるsource契約。
- `internal/port/authentication.ts`: session restore、validation、loginの契約。
- `internal/application/fetch.ts`: 認証後の取得とconnection invariant。
- `internal/cli/default_environment.ts`: 唯一のcomposition root。

参考adapter名をこの文書へ固定しない。必要なcapabilityを実装している既存adapterは、契約名から探す。

```powershell
rg -n "implements .*Source|AssetBalanceSource|CashInSource|CashOutSource|TransferSource" app/internal/adapter
rg -n "implements AuthenticationPort|create.*Module" app/internal/adapter
```

## 対応サイトを調べる

実装前に、権限のあるテストアカウントで次を確認する。

- ログイン開始から認証済みページまでのrequest、redirect、cookie、CSRF token。
- OTP、外部承認、passkey案内、秘密の質問などの分岐。
- ログイン済みと期限切れを確実に区別できるページ構造またはstatus。
- WAF、CAPTCHA、rate limit、障害ページとログアウト状態の違い。
- データ取得URL、pagination、取得可能期間、並び順、重複条件。
- 金額が利用額、請求額、注文合計、残高のどれを表すか。
- 日付が利用日、売上確定日、請求日、入出金日、注文日のどれか。
- cancel、refund、分割払い、複数請求、振替、未確定取引の表現。
- desktop、mobile、段階配信JSONなど、同じ意味を持つレスポンスvariant。

HAR、HTML fixture、ログからcookie、token、氏名、住所、口座番号、注文番号などを除去する。
password、OTP、cookie、session token、認証済みHTMLをそのままcommitまたはlog出力してはいけない。

サイトのJavaScript実行は最後の手段とする。必要な場合はhost processで実行せず、permissionを
最小化したWorkerへ隔離し、許可host、resource数、個別・合計byte数、timeout、出力schemaを制限する。
WAFやCAPTCHAを回避するコードは追加しない。

## 金融モデルへ対応付ける

サイトの画面名ではなく、資金移動の意味でmodelとsourceを選ぶ。

| サイト種別 | 主なsource | 注意点 |
| --- | --- | --- |
| ネットショッピング | `CashOutSource` | 注文ID、cancel、refund、分割請求、注文合計と実請求額を区別する |
| クレジットカード | `CashOutSource` | 利用日と確定日、返金、利用可能な明細cycleを明示する |
| 銀行・電子マネー | `AssetBalanceSource`、`CashInSource`、`CashOutSource`、`TransferSource` | 口座間振替を入金・出金として二重計上しない |
| 家計簿・集約サービス | 複数source | aggregation対象外、同一取引、金融機関・wallet identityを保持する |

モデル化では次を守る。

- 期間は `[from, to)`。CLIの終了日はJSTでinclusiveに変換済みである。
- 日本の画面日付はJSTとして解釈し、UTCの `Date` に変換する。
- 金額は意味を確認してから正規化する。符号を根拠なく反転しない。
- transaction IDはprovider上の不変IDを優先し、`scopedID(connection.id, kind, localID)` でscopeする。
- 不変IDがない場合だけ、正規化済みの安定要素から決定的IDを作る。
- 配列index、取得時刻、表示順をIDへ含めない。
- Walletは資金の所在、Assetは取得時点の資産評価、ExternalPartyは取引相手として区別する。
- すべてのentityとWalletへ同じ `connectionID` を伝播する。
- transferをcash-inとcash-outへ重複変換しない。
- metadataには出典やサイト上の非機密識別情報だけを保存する。
- source結果は時刻とIDで決定的にsortする。

既存use caseに合わないproviderへ、意味のない空sourceを実装して形だけ合わせてはいけない。
必要なsourceだけを表すportとapplication use caseを追加し、CLIはそのuse caseを呼ぶ。

## Provider adapterの標準構成

新しいproviderは `internal/adapter/<provider>/` に閉じ込める。

```text
adapter/<provider>/
├── context.ts              共有HttpSession、base URL、connection、認証状態
├── errors.ts               provider固有のtyped error
├── login.ts                loginとsession validation
├── authentication.ts       AuthenticationPort実装とsnapshot境界
├── parser.ts               副作用のないresponse解析とmodel変換
├── adapter.ts              Source port実装と取得手順
├── module.ts               context、auth、sourceを組み立てる入口
├── parser_test.ts
├── authentication_test.ts
├── login_test.ts
└── adapter_test.ts
```

不要なファイルを雛形のためだけに作らない。動的script実行など大きな補助機構だけ、役割が分かる名前で
追加する。内部実装を一括再exportする `mod.ts` barrelは作らない。composition rootは
`module.ts` のfactoryだけをimportする。

### Contextとmodule

- provider IDは小文字の安定したslugにする。
- base URLはscheme、credential、query、fragmentを検証し、意図したoriginだけを許可する。
- 認証とsourceは必ず同じcontext、HttpSession、connectionを共有する。
- 認証状態は少なくとも `empty`、`restored`、`valid`、`expired` を区別する。
- `module.ts` は部品生成だけを行い、認証や取得を開始しない。
- moduleの具体型をapplicationやCLIへ渡さず、composition rootでuse caseへ分解して注入する。

### AuthenticationPort

- `restoreSession(unknown)` は外部入力のtrust boundaryである。全fieldを検証してからatomicに復元する。
- provider、schema version、connection ID、capturedAt、payload shape、cookie domainを検証する。
- snapshot復元だけで認証済みにしない。server上の認証済みページを確認して `valid` にする。
- status 200だけで成功判定せず、認証済みページ固有の構造と最終origin/pathを確認する。
- CAPTCHA、WAF、403、5xx、network failureを安易にsession期限切れへ分類しない。
- login開始時と失敗時は部分的なcookieやprovider stateを消去する。
- OTPや外部承認は `AuthInteraction` を通し、adapter内でpromptやconsoleを呼ばない。
- captureは検証済みsessionにだけ許可する。
- snapshotへpassword、OTP、秘密の質問、不要な個人情報を含めない。
- schema変更時はversionを上げ、古いsnapshotをtyped rejectionとして扱う。

session復元、新規login、保存、再認証の順序は `AuthCoordinator` に任せる。provider側やCLIで
同じ手順を再実装しない。

### HTTPとparser

- requestは原則として共通の `HttpSession` を使い、cookieと安全なredirect処理を再利用する。
- response bodyは `readTextLimited` または `readBytesLimited` で上限を設ける。
- `AbortSignal` を全request、待機、Workerへ伝播し、abort理由を別のerrorで包まない。
- paginationには明示的な最大page数を設ける。無限retryを実装しない。
- cross-origin URL、redirect、form action、外部script URLは送信前に検証する。
- parserはnetwork、認証状態、console、環境変数へ触れないpure functionにする。
- HTMLは構造化parserで解析し、巨大な正規表現やscript実行へ依存しない。
- 必須構造markerがない200ページは空配列にせず `UnexpectedPageError` などでfail closedする。
- 「取引0件」を示す明示的な空ページと、解析不能ページを区別する。
- 請求額候補が複数あり整合しない場合、都合のよい値を選ばず曖昧さをerrorにする。
- desktop、mobile、JSON fragmentなど既知variantは同じ中間表現へ正規化してからmodel化する。

### Source adapter

- 対応する `AssetBalanceSource`、`CashInSource`、`CashOutSource`、`TransferSource` だけを実装する。
- 取得前にcontextが `valid` であることを確認する。
- loginページへの確実な遷移を検出した場合だけstateを `expired` にし、
  `AuthenticationRequiredError` 派生errorを投げる。
- 取得期間をprovider requestと最終結果の両方で制限する。
- page間の重複は安定IDで除去する。
- providerの低水準errorへ操作名、page、期間などの文脈を加える。ただし秘密情報は含めない。

## ApplicationとCLIへ接続する

1. `module.ts` でauthentication portとsource portを生成する。
2. 既存のapplication use caseが意味的に合うか確認する。
3. 合わなければprovider非依存の新しいuse caseを `internal/application/` に作る。
4. use case内で認証、source orchestration、並列化、connection invariantを扱う。
5. `CLIEnvironment` はadapter moduleではなくapplication use caseを返す。
6. `default_environment.ts` だけで具体moduleを生成し、use caseへportを注入する。
7. CLIにはprovider routing、引数、credential interaction、表示だけを追加する。

provider追加時に確認するCLI箇所は次のとおり。

- `cli/arguments.ts`: 対応provider IDとprovider固有option。
- `cli/runtime.ts`: adapter型を漏らさないuse case factory。
- `cli/default_environment.ts`: 具体adapterのcomposition。
- `cli/fetch_command.ts`: commandからuse caseを1回呼ぶ配線。
- `cli/credentials.ts`: 環境変数名、prompt、入力validation。
- `cli/presenter.ts`: table/JSON表示。domain invariantをここで検証しない。
- `cli/usage.ts` と `deno.json`: usage、task、`--allow-env` の最小権限。

provider追加によってCLIに認証手順、cookie処理、複数sourceの `Promise.all`、データ整合性検証を
書き始めた場合は中止し、application use caseへ戻す。

## テスト方針

外部サイトへ接続するテストや実credentialを必要とするテストを通常のtest suiteへ入れない。
保存したfixtureまたはlocalhostのtest serverを使い、次を検証する。

### Parser

- 正常な実レスポンスを匿名化したfixture。
- desktop/mobileなど既知variant。
- 0件ページ。
- cancel、refund、transfer、重複、複数請求などprovider固有の境界例。
- 必須構造欠落、曖昧な金額、不正な日付・金額をfail closedする例。
- stable ID、JST変換、connection ID、deterministic sort。

### Authentication

- snapshotのround trip。
- foreign provider、別connection、未知schema、malformed payload、許可外cookie domainの拒否。
- restore後にvalidationを要求すること。
- OTPまたは外部承認が `AuthInteraction` を通ること。
- login失敗後にsessionをclearすること。
- WAFや曖昧な403をexpiredと誤分類しないこと。
- 動的コードを使う場合、環境変数・filesystem・任意networkへ到達できないこと。

### Sourceとapplication

- localhost serverでrequest method、path、query、header、paginationを検証する。
- 認証切れだけが `AuthenticationRequiredError` になること。
- response size、page上限、abort理由が保たれること。
- application use caseが認証後に全sourceを取得すること。
- 別connectionのentity混入をapplication層が拒否すること。

### CLI

- 環境変数と対話入力からcredentialを取得すること。
- 保存済みsessionではcredentialを要求しないこと。
- `--reauth`、profile、期間、table/JSON出力。
- CLIテストでは具体adapter module型をimportしないこと。

変更後は `app/` で次を実行する。

```powershell
deno task fmt:check
deno task lint
deno task check
deno task test
```

新しいWorker entry pointを追加した場合は `deno.json` の `compile.include` とcompile taskも確認する。

## 完了条件

- 依存方向に違反するimportがない。
- 具体adapterへの依存はprovider folderとcomposition rootに閉じている。
- CLIはuse caseを呼び、取得手順を知らない。
- modelの意味、日付、金額、stable ID、transfer方針がテストで固定されている。
- session snapshotにcredentialやOTPが含まれない。
- parserはサイト変更を空データとして隠さずfail closedする。
- response、pagination、Workerにresource上限とabort経路がある。
- fixtureとerror messageに秘密情報や個人情報がない。
- format、lint、型検査、全テストが成功する。

provider固有の一時的なDOM selectorやURL一覧はこの文書へ増やさず、adapterのcodeとfixture testへ置く。
複数providerに再利用できる判断規則が見つかったときだけ、この文書へ追記する。
