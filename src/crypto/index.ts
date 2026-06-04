import { CreateInvoce, CURRENCY, type Invoice } from "../store.ts";
import { EvmProvider } from "./evm.ts";
import { CURRENCY_TYPE, PaymentCheckResult, PaymentProvider } from "./interface.ts";
import { TronProvider } from "./tron.ts";
const CHAINIDS = { BNB: 56, ETH: 1 }
const TOKENS = {
    USDT: {
        ETH: "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    }
}

export interface BlockChainConfig {
    evm_api_key: string,
    EVM_RPC?: string,
    EVM_RESERVE_ETH?: number,
    TRON_RPC?: string,
    TRON_DERIVATION_PATH?: string,
    TRON_RESERVE_TRX?: number,
    MNEMONIC: string,
}
export class BlockChainProvider {
    public evm_provider: EvmProvider
    public tron_provider: TronProvider


    constructor(config: BlockChainConfig) {
        this.evm_provider = new EvmProvider(config.evm_api_key, CHAINIDS.ETH, config.MNEMONIC, config.EVM_RPC || "https://eth.drpc.org", config.EVM_RESERVE_ETH)
        this.tron_provider = new TronProvider(config.MNEMONIC, config.TRON_RESERVE_TRX, config.TRON_RPC || "https://tron.api.pocket.network", config.TRON_DERIVATION_PATH)
    }
    available_currency() {
        return { [CURRENCY.TRX]: "Tron", [CURRENCY.USDT_TRC20]: "Tron USDT", [CURRENCY.ETH]: "Etherium ETH", [CURRENCY.USDT_ETH]: "Etherium USDT" }
    }
    withdraw_available_currency() {
        return { [CURRENCY.TRX]: "Tron", [CURRENCY.USDT_TRC20]: "Tron USDT", [CURRENCY.ETH]: "Etherium ETH", [CURRENCY.USDT_ETH]: "Etherium USDT" }
    }
    checkWithdrawAvalibeCurrency(currency: CURRENCY_TYPE) {
        if (!Object.keys(this.withdraw_available_currency()).includes(currency)) {
            throw new Error("This currency not implement")
        }
    }


    async withdraw(index_key: number, wallet: string, value: number, currency: CURRENCY_TYPE): Promise<PaymentCheckResult> {
        switch (currency) {
            case CURRENCY.TRX:
            case CURRENCY.USDT_TRC20:
                return this.tron_provider.withdraw(index_key, wallet, value, currency)
                break;

            case CURRENCY.ETH:
            case CURRENCY.USDT_ETH:
                return this.evm_provider.withdraw(index_key, wallet, value, currency)
                break;
        }

    }
    async getPayStatus(wallet: string, value: number, currency: CURRENCY_TYPE, invoceStartTimestamp: number): Promise<PaymentCheckResult> {
        switch (currency) {
            case CURRENCY.TRX:
            case CURRENCY.USDT_TRC20:
                return this.tron_provider.getPayStatus(wallet, value, currency, { startTimeStamp: invoceStartTimestamp })
                break;

            case CURRENCY.ETH:
            case CURRENCY.USDT_ETH:
                return this.evm_provider.getPayStatus(wallet, value, currency, { startTimeStamp: invoceStartTimestamp })
                break;


        }
    }

    async claim(outgoing_wallet_evm: string, outgoing_wallet_tron: string, walletCount?: number) {
        console.log("start claoim ")

        await this.evm_provider.claim(outgoing_wallet_evm, walletCount)
        await this.tron_provider.claim(outgoing_wallet_tron, walletCount)
    }

    async createNewInvoce(index_key: string, currency: CURRENCY_TYPE): Promise<string> {
        switch (currency) {
            case CURRENCY.TRX:
            case CURRENCY.USDT_TRC20:
                return this.tron_provider.getAddressForPay(index_key, currency)
                break;

            case CURRENCY.ETH:
            case CURRENCY.USDT_ETH:
                return this.evm_provider.getAddressForPay(index_key, currency)
                break;
        }
        throw new Error("not implemented")
    }
}    
