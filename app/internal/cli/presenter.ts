import type {
  CashFlowFetchResult,
  CashOutFetchResult,
  FinancialSnapshotFetchResult,
} from "../application/fetch.ts";
import type { Wallet } from "../model/account.ts";
import { formatJSTDate } from "./date.ts";

export interface PresentationOptions {
  readonly periodLabels: {
    readonly from: string;
    readonly to: string;
  };
  readonly format: "table" | "json";
}

export function presentCashOuts(
  result: CashOutFetchResult,
  options: PresentationOptions,
): string {
  const totalAmount = sum(result.cashOuts.map((cashOut) => cashOut.amount));
  if (options.format === "json") {
    return JSON.stringify(
      {
        connection: result.connection,
        period: options.periodLabels,
        count: result.cashOuts.length,
        totalAmount,
        cashOuts: result.cashOuts.map((cashOut) => ({
          id: cashOut.id,
          date: formatJSTDate(cashOut.occurredAt),
          amount: cashOut.amount,
          connectionID: cashOut.connectionID,
          fromWallet: serializeWallet(cashOut.from),
          merchant: cashOut.to.name,
          metadata: cashOut.to.metadata,
        })),
      },
      null,
      2,
    );
  }

  const isAmazon = result.connection.provider === "amazon";
  return [
    `期間: ${options.periodLabels.from} 〜 ${options.periodLabels.to}`,
    `件数: ${result.cashOuts.length}件  合計: ${formatJPY(totalAmount)}`,
    "",
    isAmazon ? "日付\t金額\t商品名" : "日付\t金額\t利用先",
    ...result.cashOuts.map((cashOut) =>
      `${formatJSTDate(cashOut.occurredAt)}\t${cashOut.amount}円\t${
        isAmazon ? amazonItemTitles(cashOut.to.metadata) : cashOut.to.name
      }`
    ),
  ].join("\n");
}

function amazonItemTitles(metadata: Readonly<Record<string, string>>): string {
  const itemTitles = metadata.items?.trim();
  return itemTitles === undefined || itemTitles === ""
    ? "（商品名を取得できませんでした）"
    : itemTitles;
}

export function presentCashFlow(
  result: CashFlowFetchResult,
  options: PresentationOptions,
): string {
  const totalCashInAmount = sum(result.cashIns.map((cashIn) => cashIn.amount));
  const totalCashOutAmount = sum(result.cashOuts.map((cashOut) => cashOut.amount));
  if (options.format === "json") {
    return JSON.stringify(
      {
        connection: result.connection,
        period: options.periodLabels,
        cashFlow: {
          cashInCount: result.cashIns.length,
          cashOutCount: result.cashOuts.length,
          totalCashInAmount,
          totalCashOutAmount,
          cashIns: result.cashIns.map((cashIn) => ({
            id: cashIn.id,
            connectionID: cashIn.connectionID,
            date: formatJSTDate(cashIn.occurredAt),
            amount: cashIn.amount,
            from: cashIn.from.name,
            toWallet: serializeWallet(cashIn.to),
            metadata: cashIn.from.metadata,
          })),
          cashOuts: result.cashOuts.map((cashOut) => ({
            id: cashOut.id,
            connectionID: cashOut.connectionID,
            date: formatJSTDate(cashOut.occurredAt),
            amount: cashOut.amount,
            fromWallet: serializeWallet(cashOut.from),
            to: cashOut.to.name,
            metadata: cashOut.to.metadata,
          })),
        },
      },
      null,
      2,
    );
  }

  return [
    `キャッシュフロー: ${options.periodLabels.from} 〜 ${options.periodLabels.to}`,
    `入金: ${result.cashIns.length}件 ${formatJPY(totalCashInAmount)}  ` +
    `出金: ${result.cashOuts.length}件 ${formatJPY(totalCashOutAmount)}`,
    "種別\t日付\t金額\t内容\tウォレット",
    ...result.cashIns.map((cashIn) =>
      `入金\t${formatJSTDate(cashIn.occurredAt)}\t${formatJPY(cashIn.amount)}` +
      `\t${cashIn.from.name}\t${cashIn.to.name}`
    ),
    ...result.cashOuts.map((cashOut) =>
      `出金\t${formatJSTDate(cashOut.occurredAt)}\t${formatJPY(cashOut.amount)}` +
      `\t${cashOut.to.name}\t${cashOut.from.name}`
    ),
  ].join("\n");
}

export function presentFinancialSnapshot(
  result: FinancialSnapshotFetchResult,
  options: PresentationOptions,
): string {
  const totals = {
    assets: sum(result.assetBalances.map((balance) => balance.amount)),
    cashIns: sum(result.cashIns.map((cashIn) => cashIn.amount)),
    cashOuts: sum(result.cashOuts.map((cashOut) => cashOut.amount)),
    transfers: sum(result.transfers.map((transfer) => transfer.amount)),
  };

  if (options.format === "json") {
    return presentFinancialSnapshotJSON(result, options, totals);
  }
  return presentFinancialSnapshotTable(result, options, totals);
}

interface FinancialTotals {
  readonly assets: number;
  readonly cashIns: number;
  readonly cashOuts: number;
  readonly transfers: number;
}

function presentFinancialSnapshotJSON(
  result: FinancialSnapshotFetchResult,
  options: PresentationOptions,
  totals: FinancialTotals,
): string {
  return JSON.stringify(
    {
      connection: result.connection,
      period: options.periodLabels,
      assets: {
        count: result.assetBalances.length,
        totalAmount: totals.assets,
        balances: result.assetBalances.map((balance) => ({
          id: balance.asset.id,
          connectionID: balance.asset.connectionID,
          name: balance.asset.name,
          amount: balance.amount,
          observedAt: balance.observedAt.toISOString(),
          metadata: balance.asset.metadata,
        })),
      },
      cashFlow: {
        cashInCount: result.cashIns.length,
        cashOutCount: result.cashOuts.length,
        transferCount: result.transfers.length,
        totalCashInAmount: totals.cashIns,
        totalCashOutAmount: totals.cashOuts,
        totalTransferAmount: totals.transfers,
        cashIns: result.cashIns.map((cashIn) => ({
          id: cashIn.id,
          connectionID: cashIn.connectionID,
          date: formatJSTDate(cashIn.occurredAt),
          amount: cashIn.amount,
          from: cashIn.from.name,
          toWallet: serializeWallet(cashIn.to),
          metadata: cashIn.from.metadata,
        })),
        cashOuts: result.cashOuts.map((cashOut) => ({
          id: cashOut.id,
          connectionID: cashOut.connectionID,
          date: formatJSTDate(cashOut.occurredAt),
          amount: cashOut.amount,
          fromWallet: serializeWallet(cashOut.from),
          to: cashOut.to.name,
          metadata: cashOut.to.metadata,
        })),
        transfers: result.transfers.map((transfer) => ({
          id: transfer.id,
          connectionID: transfer.connectionID,
          date: formatJSTDate(transfer.occurredAt),
          amount: transfer.amount,
          fromWallet: serializeWallet(transfer.from),
          toWallet: serializeWallet(transfer.to),
        })),
      },
    },
    null,
    2,
  );
}

function presentFinancialSnapshotTable(
  result: FinancialSnapshotFetchResult,
  options: PresentationOptions,
  totals: FinancialTotals,
): string {
  return [
    "現在資産",
    `件数: ${result.assetBalances.length}件  合計: ${formatJPY(totals.assets)}`,
    "名称\t金額\t金融機関",
    ...result.assetBalances.map((balance) =>
      `${balance.asset.name}\t${formatJPY(balance.amount)}\t${
        balance.asset.metadata.institution ?? ""
      }`
    ),
    "",
    `キャッシュフロー: ${options.periodLabels.from} 〜 ${options.periodLabels.to}`,
    `入金: ${result.cashIns.length}件 ${formatJPY(totals.cashIns)}  ` +
    `出金: ${result.cashOuts.length}件 ${formatJPY(totals.cashOuts)}  ` +
    `振替: ${result.transfers.length}件 ${formatJPY(totals.transfers)}`,
    "種別\t日付\t金額\t内容\tウォレット",
    ...result.cashIns.map((cashIn) =>
      `入金\t${formatJSTDate(cashIn.occurredAt)}\t${formatJPY(cashIn.amount)}` +
      `\t${cashIn.from.name}\t${cashIn.to.name}`
    ),
    ...result.cashOuts.map((cashOut) =>
      `出金\t${formatJSTDate(cashOut.occurredAt)}\t${formatJPY(cashOut.amount)}` +
      `\t${cashOut.to.name}\t${cashOut.from.name}`
    ),
    ...result.transfers.map((transfer) =>
      `振替\t${formatJSTDate(transfer.occurredAt)}\t${formatJPY(transfer.amount)}` +
      `\t${transfer.from.name}\t${transfer.to.name}`
    ),
  ].join("\n");
}

function serializeWallet(wallet: Wallet): Wallet {
  return {
    id: wallet.id,
    connectionID: wallet.connectionID,
    name: wallet.name,
    metadata: wallet.metadata,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatJPY(value: number): string {
  return `${new Intl.NumberFormat("ja-JP").format(value)}円`;
}
