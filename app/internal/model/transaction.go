package model

import "time"

type ExternalParty struct {
	Name     string
	Metadata map[string]string
}

type CashIn struct {
	ID         string
	Amount     int64
	OccurredAt time.Time
	From       ExternalParty
	To         WalletID
}

type CashOut struct {
	ID         string
	Amount     int64
	OccurredAt time.Time
	From       WalletID
	To         ExternalParty
}

type Transfer struct {
	ID         string
	Amount     int64
	OccurredAt time.Time
	From       WalletID
	To         WalletID
}
