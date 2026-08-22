package port

import (
	"context"
	"time"

	"github.com/nezow/Okura/app/internal/model"
)

type Period struct {
	From time.Time
	To   time.Time
}

type CashInSource interface {
	FetchCashIns(
		ctx context.Context,
		period Period,
	) ([]model.CashIn, error)
}

type CashOutSource interface {
	FetchCashOuts(
		ctx context.Context,
		period Period,
	) ([]model.CashOut, error)
}

type TransferSource interface {
	FetchTransfers(
		ctx context.Context,
		period Period,
	) ([]model.Transfer, error)
}
