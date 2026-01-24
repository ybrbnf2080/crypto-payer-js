export const INVOCE_STATUS = {
    AWAIT: "AWAIT",
    PAYED: "PAYED",
    FINISH: "FINISH",
    DENY: "DENY",
    OUT_AWAIT: "OUT_AWAIT",
    OUT_FINISH: "OUT_FINISH",
    OUT_ERROR: "OUT_ERROR",
} as const

export const WALLET_STATUS = {
    USED: "USED",
    FREE: "FREE",
} as const

export const CURRENCY = {
    USDT_TRC20: "USDT_TRC20",
    TRX: "TRX",
    ETH: "ETH",
    USDT_ETH: "USDT_ETH",
} as const

export type InvoiceStatus = keyof typeof INVOCE_STATUS
export type WalletStatus = keyof typeof WALLET_STATUS

export interface Invoice {
    id: number,
    status: InvoiceStatus,
    index_key: number,
    wallet: string,
    hash?: string | null,
    callback_data: string,
    memo?: string | null,
    amount: number,
    currency: keyof typeof CURRENCY,
    created_at: number | Date,
}
export interface CreateInvoce {
    wallet: string,
    index_key: number,
    status: InvoiceStatus,
    callback_data: string,
    memo?: string,
    amount: number,
    currency: keyof typeof CURRENCY,
}
export interface FreeWallet {
    id: number,
    status: WalletStatus,
}

export interface PaymentStorage {
    create(data: CreateInvoce): Promise<Invoice>
    getByStatus(status: InvoiceStatus): Promise<Invoice[]>
    getFreeWalletsAndLockOrCreate(): Promise<FreeWallet>
    unlockWallet(wallet_id: number): Promise<boolean>
    update(
        id: number,
        data: Partial<Omit<Invoice, "id" | "id">>,
        options?: any
    ): Promise<Invoice>
    updateByCallback_data(
        callback_data: string,
        data: Partial<Omit<Invoice, "id" | "id">>
    ): Promise<void>
}

export class InMemoryPaymentStorage implements PaymentStorage {
    private invoices = new Map<number, Invoice>()
    private callbackIndex = new Map<string, number>()
    private idSeq = 1

    async create(data: CreateInvoce): Promise<Invoice> {
        const id = this.idSeq++

        const invoice: Invoice = {
            id,
            status: data.status,
            index_key: 1,
            wallet: data.wallet,
            hash: "",
            callback_data: data.callback_data,
            memo: data.memo ?? "",
            amount: data.amount,
            currency: data.currency,
            created_at: Date.now(),
        }

        this.invoices.set(id, invoice)
        this.callbackIndex.set(invoice.callback_data, id)

        return { ...invoice }
    }

    async getByStatus(status: InvoiceStatus): Promise<Invoice[]> {
        return Array.from(this.invoices.values())
            .filter(inv => inv.status === status)
            .map(inv => ({ ...inv }))
    }
    async getFreeWalletsAndLockOrCreate(): Promise<FreeWallet> {
        return {
            id: 1,
            status: WALLET_STATUS.FREE
        }
    }

    async unlockWallet(wallet_id: number): Promise<boolean> {
        return true
    }

    async update(
        id: number,
        data: Partial<Omit<Invoice, "id">>
    ): Promise<Invoice> {
        const invoice = this.invoices.get(id)
        if (!invoice) throw new Error("Invoce not found")

        const updated: Invoice = {
            ...invoice,
            ...data,
            id: invoice.id, // защита от перезаписи
        }

        this.invoices.set(id, updated)

        if (
            data.callback_data &&
            data.callback_data !== invoice.callback_data
        ) {
            this.callbackIndex.delete(invoice.callback_data)
            this.callbackIndex.set(data.callback_data, id)
        }
        return this.invoices.get(id) as Invoice
    }

    async updateByCallback_data(
        callback_data: string,
        data: Partial<Omit<Invoice, "id">>
    ): Promise<void> {
        const id = this.callbackIndex.get(callback_data)
        if (!id) return

        await this.update(id, data)
    }
}

export class InvoceDB {
    private db: PaymentStorage
    constructor(db: PaymentStorage) {
        this.db = db
    }

    async save(invoice: CreateInvoce) {
        await this.db.create(invoice)
    }
    async getActive(): Promise<Invoice[]> {
        const result = await this.db.getByStatus(INVOCE_STATUS.AWAIT)
        return result
    }
    async getPaid(): Promise<Invoice[]> {
        const result = await this.db.getByStatus(INVOCE_STATUS.PAYED)

        return result as Invoice[]
    }
    async getFreeWallet(): Promise<FreeWallet> {
        const result = await this.db.getFreeWalletsAndLockOrCreate()

        return result
    }
    async setPaid(id: number, hash: string,) {
        await this.db.update(id, { hash: hash, status: INVOCE_STATUS.PAYED })
    }

    async setFinish(id: number,) {
        const wallet = await this.db.update(id, { status: INVOCE_STATUS.FINISH })
        await this.db.unlockWallet(wallet.index_key)
    }

    async setDeny(id: number,) {
        const wallet = await this.db.update(id, { status: INVOCE_STATUS.DENY })
        await this.db.unlockWallet(wallet.index_key)
    }


    /// Withdraw
    async getOutWait(): Promise<Invoice[]> {
        const result = await this.db.getByStatus(INVOCE_STATUS.OUT_AWAIT)

        return result as Invoice[]
    }

    async setOutFinish(
        id: number,
        hash: string,
    ) {
        await this.db.update(id, { hash: hash, status: INVOCE_STATUS.OUT_FINISH })
    }
    async setOutError(
        id: number,
        error: string
    ) {
        await this.db.update(id, { status: INVOCE_STATUS.OUT_ERROR, hash: error })
    }

}

