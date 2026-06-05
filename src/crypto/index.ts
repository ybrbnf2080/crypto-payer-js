import { CreateInvoce, CURRENCY, type Invoice } from "../store.ts";
import { EvmProvider } from "./evm.ts";
import { CURRENCY_TYPE, PaymentCheckResult, PaymentProvider } from "./interface.ts";
import { TronProvider } from "./tron.ts";
import { BnbProvider } from "./bnb.ts";
import { BitcoinProvider } from "./bitcoin.ts";

const CHAINIDS = { BNB: 56, ETH: 1 }
const TOKENS = {
    USDT: {
        ETH: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        BSC: "0x55d398326f99059fF775485246999027B3197955"
    }
}

export interface BlockChainConfig {
    evm_api_key: string,
    EVM_RPC?: string,
    EVM_RESERVE_ETH?: number,
    TRON_RPC?: string,
    TRON_DERIVATION_PATH?: string,
    TRON_RESERVE_TRX?: number,
    BSC_API_KEY?: string,
    BSC_RPC?: string,
    BSC_RESERVE_BNB?: number,
    MNEMONIC: string,
    require_confirm_withdraw?: boolean,
}

export class BlockChainProvider {
    public evm_provider: EvmProvider
    public tron_provider: TronProvider
    public bnb_provider: BnbProvider
    public btc_provider: BitcoinProvider

    constructor(config: BlockChainConfig) {
        this.evm_provider = new EvmProvider(config.evm_api_key, CHAINIDS.ETH, config.MNEMONIC, config.EVM_RPC || "https://eth.drpc.org", config.EVM_RESERVE_ETH)
        this.tron_provider = new TronProvider(config.MNEMONIC, config.TRON_RESERVE_TRX, config.TRON_RPC || "https://tron.api.pocket.network", config.TRON_DERIVATION_PATH)
        this.bnb_provider = new BnbProvider(config.BSC_API_KEY || config.evm_api_key, config.MNEMONIC, config.BSC_RPC || "https://bsc-dataseed.binance.org", config.BSC_RESERVE_BNB)
        this.btc_provider = new BitcoinProvider(config.MNEMONIC)
    }

    available_currency() {
        return { [CURRENCY.TRX]: "Tron", [CURRENCY.USDT_TRC20]: "Tron USDT", [CURRENCY.ETH]: "Etherium ETH", [CURRENCY.USDT_ETH]: "Etherium USDT", [CURRENCY.BNB]: "Binance BNB", [CURRENCY.BSC_USDT]: "Binance USDT", [CURRENCY.BTC]: "Bitcoin" }
    }

    withdraw_available_currency() {
        return { [CURRENCY.USDT_TRC20]: "Tron USDT", [CURRENCY.USDT_ETH]: "Etherium USDT", [CURRENCY.BSC_USDT]: "Binance USDT", }
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
            case CURRENCY.ETH:
            case CURRENCY.USDT_ETH:
                return this.evm_provider.withdraw(index_key, wallet, value, currency)
            case CURRENCY.BNB:
            case CURRENCY.BSC_USDT:
                return this.bnb_provider.withdraw(index_key, wallet, value, currency)
            case CURRENCY.BTC:
                return this.btc_provider.withdraw(index_key, wallet, value, currency)
        }
    }

    async getPayStatus(wallet: string, value: number, currency: CURRENCY_TYPE, invoceStartTimestamp: number): Promise<PaymentCheckResult> {
        switch (currency) {
            case CURRENCY.TRX:
            case CURRENCY.USDT_TRC20:
                return this.tron_provider.getPayStatus(wallet, value, currency, { startTimeStamp: invoceStartTimestamp })
            case CURRENCY.ETH:
            case CURRENCY.USDT_ETH:
                return this.evm_provider.getPayStatus(wallet, value, currency, { startTimeStamp: invoceStartTimestamp })
            case CURRENCY.BNB:
            case CURRENCY.BSC_USDT:
                return this.bnb_provider.getPayStatus(wallet, value, currency, { startTimeStamp: invoceStartTimestamp })
            case CURRENCY.BTC:
                return this.btc_provider.getPayStatus(wallet, value, currency, { startTimeStamp: invoceStartTimestamp })
        }
    }

    async claim(outgoing_wallet_evm: string, outgoing_wallet_tron: string, outgoing_wallet_bsc?: string, outgoing_wallet_btc?: string, walletCount?: number) {
        console.log("start claim")
        await this.evm_provider.claim(outgoing_wallet_evm, walletCount)
        await this.tron_provider.claim(outgoing_wallet_tron, walletCount)
        if (outgoing_wallet_bsc) {
            await this.bnb_provider.claim(outgoing_wallet_bsc, walletCount)
        }
        if (outgoing_wallet_btc) {
            await this.btc_provider.claim(outgoing_wallet_btc, walletCount)
        }
    }

    async createNewInvoce(index_key: string, currency: CURRENCY_TYPE): Promise<string> {
        switch (currency) {
            case CURRENCY.TRX:
            case CURRENCY.USDT_TRC20:
                return this.tron_provider.getAddressForPay(index_key, currency)
            case CURRENCY.ETH:
            case CURRENCY.USDT_ETH:
                return this.evm_provider.getAddressForPay(index_key, currency)
            case CURRENCY.BNB:
            case CURRENCY.BSC_USDT:
                return this.bnb_provider.getAddressForPay(index_key, currency)
            case CURRENCY.BTC:
                return this.btc_provider.getAddressForPay(index_key, currency)
        }
        throw new Error("not implemented")
    }
}
