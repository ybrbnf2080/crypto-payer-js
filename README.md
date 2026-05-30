# crypto-payer-js

> TypeScript library for processing cryptocurrency payments and managing multiple HD wallets.

[![npm version](https://img.shields.io/npm/v/crypto-payer-js.svg)](https://www.npmjs.com/package/crypto-payer-js)
[![License](https://img.shields.io/npm/l/crypto-payer-js.svg)](https://github.com/akane_tendo/crypto-payer-js/blob/main/LICENSE)

## Features

- **Multi-blockchain** — supports TRON (TRX, USDT TRC20) and Ethereum (ETH, USDT ERC20)
- **HD Wallet** — derives addresses from a single BIP39 mnemonic using BIP32
- **Invoicing** — create payment invoices with automatic address generation
- **Payment verification** — check transaction status via blockchain explorers (Tronscan, Etherscan)
- **Withdrawal** — send coins/tokens from derived wallets to external addresses
- **Scheduler** — built-in cron-based automatic payment and withdrawal processing
- **Pluggable storage** — provides `InMemoryPaymentStorage`; implement `PaymentStorage` for any DB (PostgreSQL, MySQL, SQLite, etc.)
- **Callbacks** — receive notifications when invoices are paid

## Install

```bash
npm install crypto-payer-js
```

## Quick Start

```typescript
import {
  PaymentScheduler,
  InMemoryPaymentStorage,
} from "crypto-payer-js";

const db = new InMemoryPaymentStorage();
const config = {
  evm_api_key: "YOUR_ETHERSCAN_API_KEY",
  MNEMONIC: "your twelve word mnemonic phrase here",
};

const onPaid = async (invoice) => {
  console.log(`Invoice #${invoice.id} paid! Deliver goods.`);
  return true;
};

const onWithdrawn = async (invoice) => {
  console.log(`Withdrawal #${invoice.id} processed.`);
  return true;
};

const payments = new PaymentScheduler(db, config, onPaid, onWithdrawn);

payments.start_scheduler("*/1 * * * *");
```

## Usage

### Creating an invoice

```typescript
import { PaymentAction, InMemoryPaymentStorage } from "crypto-payer-js";

const db = new InMemoryPaymentStorage();
const action = new PaymentAction(db, {
  evm_api_key: "YOUR_ETHERSCAN_API_KEY",
  MNEMONIC: "your twelve word mnemonic phrase here",
});

const invoice = await action.invoce_create({
  amount: 50,                   // USDT amount
  currency: "USDT_TRC20",       // or "TRX" | "ETH" | "USDT_ETH"
  callback_data: "order-12345",
});

console.log(`Send ${invoice.amount} USDT to: ${invoice.wallet}`);
```

### Checking available currencies

```typescript
// Currencies supported for incoming payments
console.log(action.available_currency());
// { USDT_TRC20: "Tron USDT", TRX: "Tron", ETH: "Etherium ETH", USDT_ETH: "Etherium USDT" }

// Currencies supported for withdrawals
console.log(action.withdraw_available_currency());
// { USDT_TRC20: "Tron USDT", TRX: "Tron" }
```

### Creating a withdrawal

```typescript
const withdraw = await action.withdraw_create({
  amount: 10,
  currency: "USDT_TRC20",
  wallet: "TXYZ...recipient-address",
  callback_data: "withdraw-001",
});
```

### Using the scheduler

```typescript
const scheduler = new PaymentScheduler(
  db,
  config,
  async (invoice) => {
    // Called when payment is confirmed
    console.log(`Paid: ${invoice.id}`);
    return true;
  },
  async (invoice) => {
    // Called before executing a withdrawal
    console.log(`Processing withdrawal: ${invoice.id}`);
    return true;
  }
);

// Start checking every 30 seconds
scheduler.start_scheduler("*/30 * * * * *");
```

The scheduler runs three tasks on each tick:

1. **`payment_wait()`** — checks active invoices for incoming transactions
2. **`confirm_wait()`** — calls your `onPaid` callback for recently paid invoices
3. **`withdraw_wait()`** — calls `onWithdrawn` callback and executes the transfer

### Custom storage

Implement `PaymentStorage` to use your own database:

```typescript
import type { PaymentStorage, CreateInvoce, Invoice, FreeWallet } from "crypto-payer-js";

class PostgresStorage implements PaymentStorage {
  async create(data: CreateInvoce): Promise<Invoice> { /* ... */ }
  async getByStatus(status: string): Promise<Invoice[]> { /* ... */ }
  async getFreeWalletsAndLockOrCreate(): Promise<FreeWallet> { /* ... */ }
  async unlockWallet(wallet_id: number): Promise<boolean> { /* ... */ }
  async update(id: number, data: Partial<Omit<Invoice, "id">>): Promise<Invoice> { /* ... */ }
  async updateByCallback_data(callback_data: string, data: Partial<Omit<Invoice, "id">>): Promise<void> { /* ... */ }
}
```

## API

### `PaymentAction`

| Method | Description |
|---|---|
| `available_currency()` | List currencies available for incoming payments |
| `withdraw_available_currency()` | List currencies available for withdrawals |
| `invoce_create(req)` | Create a new payment invoice with a derived wallet address |
| `withdraw_create(req)` | Create a withdrawal request |

### `PaymentScheduler` (extends `PaymentAction`)

| Method | Description |
|---|---|
| `payment_wait()` | Scan active invoices for incoming transactions |
| `confirm_wait()` | Process paid invoices through the paid callback |
| `withdraw_wait()` | Process withdrawal requests through the withdraw callback |
| `start_scheduler(cron?)` | Start automatic periodic processing (defaults to every minute) |

### `PaymentStorage` interface

| Method | Description |
|---|---|
| `create(data)` | Save a new invoice |
| `getByStatus(status)` | Get invoices by status |
| `getFreeWalletsAndLockOrCreate()` | Get a free wallet index and lock it |
| `unlockWallet(id)` | Unlock/release a wallet index |
| `update(id, data)` | Update invoice fields |
| `updateByCallback_data(cb, data)` | Update invoice by callback data |

### Supported currencies

| Currency | Blockchain | Network |
|---|---|---|
| `TRX` | TRON | TRC20 |
| `USDT_TRC20` | TRON | TRC20 |
| `ETH` | Ethereum | ERC20 |
| `USDT_ETH` | Ethereum | ERC20 |

## Configuration

| Parameter | Description |
|---|---|
| `evm_api_key` | Etherscan API key (for ETH/USDT_ETH payment verification) |
| `MNEMONIC` | BIP39 mnemonic phrase for HD wallet derivation |

## License

MIT © akane_tendo
