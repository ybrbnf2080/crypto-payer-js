import axios from "axios"
import { CreateInvoce, CURRENCY, INVOCE_STATUS, } from "../store.ts"
import { sha256ToIndex } from "../setting.ts"
import * as bip39 from "bip39"
import bip32, { BIP32API } from "bip32"
import * as ecc from "tiny-secp256k1"
import * as ethers from "ethers";
import { CURRENCY_TYPE, PaymentCheckResult, PaymentProvider } from "./interface.ts"
import { sleep } from "tronweb/utils"
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
    private EVM_RPC: string
    private EVM_RESERVE_ETH: number
    readonly chain_id: number
    readonly avalibe_currency: CURRENCY_TYPE[] = [CURRENCY.ETH, CURRENCY.USDT_ETH]

    constructor(api_key: string, chain_id: number, EVM_MNEMONIC: string, EVM_RPC: string, EVM_RESERVE_ETH: number = 0) {
        this.chain_id = chain_id
        this.EVM_MNEMONIC = EVM_MNEMONIC
        this.ETHERSCAN_API_KEY = api_key
        this.EVM_RPC = EVM_RPC
        this.EVM_RESERVE_ETH = EVM_RESERVE_ETH
        this.bip32Root = bip32(ecc)
    }

    async withdraw(index_key: number, out_wallet: string, amount: number, currency: CURRENCY_TYPE) {
        switch (currency) {
            case CURRENCY.ETH:
                return await this.withdrawETH(String(index_key), out_wallet, amount)
            case CURRENCY.USDT_ETH:
                return await this.withdrawUSDT(String(index_key), out_wallet, amount)
            default:
                throw new Error("currency not supported")
        }
    }

    async withdrawETH(
        index_key: string,
        toAddress: string,
        amountETH: number
    ): Promise<PaymentCheckResult> {
        await sleep(1000)

        const child = await this.getWallet(index_key)
        if (!child.privateKey) {
            throw new Error("Failed to derive private key")
        }

        const privateKeyHex = Buffer.from(child.privateKey).toString("hex")
        const provider = new ethers.JsonRpcProvider(this.EVM_RPC)
        const wallet = new ethers.Wallet(privateKeyHex, provider)

        const amountWei = BigInt(Math.floor(amountETH * 1e18))

        const tx = await wallet.sendTransaction({
            to: toAddress,
            value: amountWei,
        })

        await tx.wait()

        return {
            txHash: tx.hash,
            paid: true,
            amount: amountETH,
        }
    }

    async withdrawUSDT(
        index_key: string,
        toAddress: string,
        amountUSDT: number
    ): Promise<PaymentCheckResult> {
        await sleep(1000)

        const child = await this.getWallet(index_key)
        if (!child.privateKey) {
            throw new Error("Failed to derive private key")
        }

        const privateKeyHex = Buffer.from(child.privateKey).toString("hex")
        const provider = new ethers.JsonRpcProvider(this.EVM_RPC)
        const wallet = new ethers.Wallet(privateKeyHex, provider)

        const USDT_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
        const amount = BigInt(Math.floor(amountUSDT * 1_000_000))

        const erc20Abi = [
            "function transfer(address to, uint256 amount) returns (bool)",
        ]

        const contract = new ethers.Contract(USDT_CONTRACT, erc20Abi, wallet)
        // @ts-ignore
        const tx = await contract.transfer(toAddress, amount)

        await tx.wait()

        return {
            txHash: tx.hash,
            paid: true,
            amount: amountUSDT,
        }
    }

    async getPayStatus(
        wallet: string,
        value: number,
        currency: CURRENCY_TYPE,
        options: {
            token_contract?: string,
            startTimeStamp: number
        }
    ): Promise<{
        paid: boolean
        txHash?: string
        amount?: number
    }> {
        const { startTimeStamp, token_contract } = options
        switch (currency) {
            case CURRENCY.ETH:
                return await this.getPayStatusETH(wallet, value, startTimeStamp)
            case CURRENCY.USDT_ETH:
                return await this.getPayStatusToken(wallet, value, "0xdAC17F958D2ee523a2206206994597C13D831ec7", startTimeStamp)

            default:
                throw new Error("This currency not implement")
        }
    }

    async getPayStatusETH(
        wallet: string,
        value: number,
        startTimeStamp: number,
    ): Promise<{
        paid: boolean
        txHash?: string
        amount?: number
    }> {
        await sleep(1000)
        const since = startTimeStamp
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
        startTimeStamp: number,
    ): Promise<{
        paid: boolean
        txHash?: string
        amount?: number
    }> {
        await sleep(1000)
        const since = startTimeStamp
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

    async claim(outgoing_wallet: string, walletCount: number = 10): Promise<void> {
        const provider = new ethers.JsonRpcProvider(this.EVM_RPC)
        const USDT_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
        const erc20Abi = [
            "function balanceOf(address) view returns (uint256)",
            "function transfer(address,uint256) returns (bool)",
        ]

        for (let i = 0; i < walletCount; i++) {
            await sleep(1000)
            const child = await this.getWallet(String(i))
            if (!child.privateKey) continue

            const privateKeyHex = Buffer.from(child.privateKey).toString("hex")
            const wallet = new ethers.Wallet(privateKeyHex, provider)

            const ethBalance = await provider.getBalance(wallet.address)
            if (ethBalance === 0n) continue

            const feeData = await provider.getFeeData()
            const gasPrice = feeData.gasPrice ?? BigInt(1e10)

            // Sweep USDT if any
            const usdtContract = new ethers.Contract(USDT_CONTRACT, erc20Abi, wallet)
            // @ts-ignore
            const usdtBalance = await usdtContract.balanceOf(wallet.address)
            if (usdtBalance > 0n) {
                // @ts-ignore
                const usdtGasEstimate = await usdtContract.transfer.estimateGas(outgoing_wallet, usdtBalance)
                const usdtGasCost = gasPrice * usdtGasEstimate
                if (ethBalance > usdtGasCost) {
                    // @ts-ignore
                    const tx = await usdtContract.transfer(outgoing_wallet, usdtBalance)
                    await tx.wait()
                }
            }

            // Sweep remaining ETH
            const remainingEth = await provider.getBalance(wallet.address)
            const ethTxGasEstimate = await provider.estimateGas({
                from: wallet.address,
                to: outgoing_wallet,
                value: remainingEth,
            })
            const ethTxGasCost = gasPrice * ethTxGasEstimate
            const reserveWei = BigInt(Math.floor(this.EVM_RESERVE_ETH * 1e18))
            const sweepAmount = remainingEth - ethTxGasCost - reserveWei
            if (sweepAmount > 0n) {
                const tx = await wallet.sendTransaction({
                    to: outgoing_wallet,
                    value: sweepAmount,
                })
                await tx.wait()
            }
        }
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