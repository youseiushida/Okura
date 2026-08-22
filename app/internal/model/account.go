package model

type WalletID string

type Wallet struct {
	ID       WalletID
	Name     string
	Metadata map[string]string
}
