import cron from "node-cron"
import { type Invoice, PaymentStorage, InvoceDB, INVOCE_STATUS } from './store.ts';
import { BlockChainConfig, BlockChainProvider } from './crypto/index.ts';
import { CURRENCY_TYPE } from "./crypto/interface.ts";


export interface CreateInvoceRequest {
    callback_data: string,
    amount: number,
    currency: CURRENCY_TYPE,
}

export interface CreateWithdrawRequest {
    callback_data: string,
    wallet: string,
    amount: number,
    currency: CURRENCY_TYPE,
}

export type IPaidCallback = (v: Invoice) => Promise<boolean>




export class PaymentAction {
    public invoce_store: InvoceDB
    public blockchainProvider: BlockChainProvider
    public invoce_ttl: number
    constructor(db: PaymentStorage, config: BlockChainConfig, invoce_ttl_minute: number = 10) {
        this.invoce_store = new InvoceDB(db)
        this.blockchainProvider = new BlockChainProvider(config)
        this.invoce_ttl = invoce_ttl_minute * 60 * 1000
    }

    public available_currency() {
        return this.blockchainProvider.available_currency()
    }
    public withdraw_available_currency() {
        return this.blockchainProvider.withdraw_available_currency()

    }
    public async invoce_create(create_invoce: CreateInvoceRequest) {

        let address = await this.invoce_store.getFreeWallet()

        const wallet = await this.blockchainProvider.createNewInvoce(String(address.id), create_invoce.currency)
        const invoice = {
            amount: create_invoce.amount,
            callback_data: create_invoce.callback_data,
            index_key: address.id,
            currency: create_invoce.currency,
            status: INVOCE_STATUS.AWAIT,
            wallet: wallet,
        }
        const invoce_db = await this.invoce_store.save(invoice)

        return invoce_db
    }

    public async claim(outgoing_wallet_evm: string, outgoing_wallet_tron: string, walletCount?: number) {
        return await this.blockchainProvider.claim(outgoing_wallet_evm, outgoing_wallet_tron, walletCount)
    }

    public async withdraw_create(withdraw_request: CreateWithdrawRequest) {
        this.blockchainProvider.checkWithdrawAvalibeCurrency(withdraw_request.currency)


        const invoice = {
            amount: withdraw_request.amount,
            callback_data: withdraw_request.callback_data,
            index_key: 0,
            currency: withdraw_request.currency,
            status: INVOCE_STATUS.OUT_AWAIT,
            wallet: withdraw_request.wallet,
        }
        await this.invoce_store.save(invoice)
        return invoice
    }
}



export class PaymentScheduler extends PaymentAction {
    private paid_callback: IPaidCallback
    private withdraw_callback: IPaidCallback
    constructor(db: PaymentStorage, config: BlockChainConfig, paid_callback: IPaidCallback, withdraw_callback: IPaidCallback) {
        super(db, config)
        this.paid_callback = paid_callback
        this.withdraw_callback = withdraw_callback
    }

    public async payment_wait() {
        await Promise.all((await this.invoce_store.getActive()).map(
            async (v: Invoice) => {
                try {
                    if (new Date(v.created_at) <= new Date(Date.now() - this.invoce_ttl)) {
                        await this.invoce_store.setDeny(v.id)
                    }
                    const status = await this.blockchainProvider.getPayStatus(v.wallet, v.amount, v.currency, Number(v.created_at))
                    if (v.id) {
                        try {

                            if (status?.paid && status?.txHash) {
                                await this.invoce_store.setPaid(v.id, status.txHash)
                            }

                        } catch (error) {
                            console.error(error)
                        }
                    }

                } catch (error) {
                    console.error(error)

                }
            }
        ));
    }
    public async confirm_wait() {
        await Promise.all((await this.invoce_store.getPaid()).map(
            async (v: Invoice) => {
                try {
                    if (v.id) {
                        if (await this.paid_callback(v)) {
                            await this.invoce_store.setFinish(v.id)
                        }
                    }
                } catch (error) {
                    console.error(error)
                }

            }
        ));
    }

    public async withdraw_wait() {
        await Promise.all((await this.invoce_store.getOutWait()).map(
            async (v: Invoice) => {
                try {
                    if (v.id) {

                        await this.withdraw_callback(v)
                        const result = await this.blockchainProvider.withdraw(v.index_key, v.wallet, v.amount, v.currency)
                        if (!result.paid || !result.txHash) {
                            throw new Error(`error paid ${v.id} ${result?.txHash}`)
                        }
                        await this.invoce_store.setOutFinish(v.id, result.txHash)

                    }
                } catch (error) {
                    await this.invoce_store.setOutError(v.id, String(error))
                    console.error(error)
                }

            }
        ));
    }

    public start_scheduler(cron_period?: string | undefined, outgoing_wallet_evm?: string, outgoing_wallet_tron?: string, walletCount?: number) {
        this.payment_wait();
        this.withdraw_wait()
        this.confirm_wait();
        if (outgoing_wallet_evm || outgoing_wallet_tron) {
            this.claim(outgoing_wallet_evm || "", outgoing_wallet_tron || "", walletCount)
        }
        cron.schedule(cron_period || "* * * * *", async () => {
            await this.payment_wait();
            await this.confirm_wait();
            await this.withdraw_wait()
            if (outgoing_wallet_evm || outgoing_wallet_tron) {
                await this.claim(outgoing_wallet_evm || "", outgoing_wallet_tron || "", walletCount)
            }
        })
        return `Confirm_started with ${cron_period || "* * * * *"}`
    }
}


import { InMemoryPaymentStorage } from "./store.ts"
export { InMemoryPaymentStorage, type PaymentStorage, type BlockChainConfig }