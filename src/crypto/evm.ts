import axios from "axios"
import { CreateInvoce, CURRENCY, INVOCE_STATUS, } from "../store.ts"
import { sha256ToIndex } from "../setting.ts"
import * as bip39 from "bip39"
import bip32, { BIP32API } from "bip32"
import * as ecc from "tiny-secp256k1"
import * as ethers from "ethers";
import { CURRENCY_TYPE, PaymentCheckResult, PaymentProvider } from "./interface.ts"
interface EvmTx {
    hash: string
    from: string
    to: string
    value: string        // wei
    timeStamp: string    // unix seconds
    isError: string
}
interface EvmTokenTx {
    hash: string
    from: string
    to: string
    value: string        // token amount (raw)
    timeStamp: string
    contractAddress: string
    tokenDecimal: string
    isError?: string
}

export class EvmProvider implements PaymentProvider {
    private bip32Root: BIP32API
    private EVM_DERIVATION_PATH = "m/44'/60'/0'/0"
    private ETHERSCAN_API_KEY: string
    private EVM_MNEMONIC: string
    readonly chain_id: number
    readonly avalibe_currency: CURRENCY_TYPE[] = [CURRENCY.ETH, CURRENCY.USDT_ETH]

    constructor(api_key: string, chain_id: number, EVM_MNEMONIC: string) {
        this.chain_id = chain_id
        this.EVM_MNEMONIC = EVM_MNEMONIC
        this.ETHERSCAN_API_KEY = api_key
        this.bip32Root = bip32(ecc)
    }

    async withdraw(index_key: number, out_wallet: string, amount: number, currency: CURRENCY_TYPE) {
        throw new Error("currency not supported")
        return {} as PaymentCheckResult
    }

    async getPayStatus(
        wallet: string,
        value: number,
        currency: CURRENCY_TYPE,
        options: {
            token_contract?: string,
            minutesBack?: number
        }
    ): Promise<{
        paid: boolean
        txHash?: string
        amount?: number
    }> {
        const { minutesBack, token_contract } = options
        switch (currency) {
            case CURRENCY.ETH:
                return await this.getPayStatusETH(wallet, value, minutesBack)
            case CURRENCY.USDT_ETH:
                return await this.getPayStatusToken(wallet, value, "0xdAC17F958D2ee523a2206206994597C13D831ec7", minutesBack)

            default:
                throw new Error("This currency not implement")
        }
    }

    async getPayStatusETH(
        wallet: string,
        value: number,
        minutesBack = 30
    ): Promise<{
        paid: boolean
        txHash?: string
        amount?: number
    }> {
        const since = Date.now() - minutesBack * 60 * 1000
        const requiredWei = BigInt(Math.floor(value * 1e18))

        const { data } = await axios.get(
            "https://api.etherscan.io/v2/api",
            {
                params: {
                    chainid: this.chain_id,
                    action: "txlist",
                    module: "account",
                    address: wallet,
                    startblock: 0,
                    endblock: 99999999,
                    offset: 1,
                    sort: "desc",
                    apikey: this.ETHERSCAN_API_KEY,
                },
            }
        )

        const txs: EvmTx[] = data.result ?? []

        for (const tx of txs) {
            const txTime = Number(tx.timeStamp) * 1000
            const amountWei = BigInt(tx.value)

            if (
                tx.to?.toLowerCase() === wallet.toLowerCase() &&
                tx.isError === "0" &&
                amountWei >= requiredWei &&
                txTime >= since
            ) {
                return {
                    paid: true,
                    txHash: tx.hash,
                    amount: Number(amountWei) / 1e18,
                }
            }
        }

        return { paid: false }
    }

    async getPayStatusToken(
        wallet: string,
        value: number,           // USDT
        token_contract: string,
        minutesBack = 30
    ): Promise<{
        paid: boolean
        txHash?: string
        amount?: number
    }> {
        const since = Date.now() - minutesBack * 60 * 1000

        // USDT has 6 decimals
        const requiredAmount = BigInt(Math.floor(value * 1e6))

        const { data } = await axios.get(
            "https://api.etherscan.io/v2/api",
            {
                params: {
                    chainid: this.chain_id,
                    action: "tokentx",
                    module: "account",
                    address: wallet,
                    contractaddress: token_contract,
                    startblock: 0,
                    endblock: 99999999,
                    offset: 1,
                    sort: "desc",
                    apikey: this.ETHERSCAN_API_KEY,
                },
            }
        )

        const txs: EvmTokenTx[] = data.result ?? []

        for (const tx of txs) {
            const txTime = Number(tx.timeStamp) * 1000
            const amount = BigInt(tx.value)

            if (
                tx.to?.toLowerCase() === wallet.toLowerCase() &&
                tx.contractAddress.toLowerCase() === token_contract.toLowerCase() &&
                amount >= requiredAmount &&
                txTime >= since
            ) {
                return {
                    paid: true,
                    txHash: tx.hash,
                    amount: Number(amount) / 1e6,
                }
            }
        }

        return { paid: false }
    }

    async claim(index_key: string) {
        const wallet = await this.getWallet(index_key)

    }
    async getWallet(index_key: string) {
        if (!this.EVM_MNEMONIC) {
            throw new Error("MNEMONIC is not set");
        }

        const seed = await bip39.mnemonicToSeed(this.EVM_MNEMONIC);
        const root = this.bip32Root.fromSeed(seed);

        const derivationIndex = sha256ToIndex(index_key);

        const child = root.derivePath(`${this.EVM_DERIVATION_PATH}/${derivationIndex}`);
        return child
    }
    // CREATE INVOCES
    async createAddressFromDerivation(callback_data: string) {
        const child = await this.getWallet(callback_data)
        if (!child.privateKey) {
            throw new Error("Failed to derive private key");
        }


        const privateKeyHex = Buffer.from(child.privateKey).toString("hex");
        const wallet = new ethers.Wallet(privateKeyHex);

        return wallet.address
    }


    async getAddressForPay(
        index_key: string,
        currency: CURRENCY_TYPE
    ): Promise<string> {
        if (!this.avalibe_currency.includes(currency)) {
            throw new Error("This currency not implement")
        }

        return await this.createAddressFromDerivation(index_key)

    }
}