import { CURRENCY_TYPE, PaymentCheckResult, PaymentProvider } from "./interface.ts"
import { CURRENCY } from "../store.ts"
import * as bip39 from "bip39"
import bip32, { BIP32API } from "bip32"
import * as ecc from "tiny-secp256k1"
import * as ethers from "ethers"
import { sha256ToIndex } from "../setting.ts"
import { sleep } from "tronweb/utils"

const BSC_USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955"

export class BnbProvider implements PaymentProvider {
    private bip32Root: BIP32API
    private DERIVATION_PATH = "m/44'/60'/0'/0"
    private MNEMONIC: string
    private RPC: string
    private RESERVE_BNB: number
    readonly chain_id = 56
    readonly avalibe_currency: CURRENCY_TYPE[] = [CURRENCY.BNB, CURRENCY.BSC_USDT]

    constructor(MNEMONIC: string, RPC: string = "https://bsc-dataseed.binance.org", RESERVE_BNB: number = 0) {
        this.MNEMONIC = MNEMONIC
        this.RPC = RPC
        this.RESERVE_BNB = RESERVE_BNB
        this.bip32Root = bip32(ecc)
    }

    async withdraw(index_key: number, out_wallet: string, amount: number, currency: CURRENCY_TYPE) {
        switch (currency) {
            case CURRENCY.BNB:
                return await this.withdrawBNB(String(index_key), out_wallet, amount)
            case CURRENCY.BSC_USDT:
                return await this.withdrawUSDT(String(index_key), out_wallet, amount)
            default:
                throw new Error("currency not supported")
        }
    }

    async withdrawBNB(
        index_key: string,
        toAddress: string,
        amountBNB: number
    ): Promise<PaymentCheckResult> {
        await sleep(1000)

        const child = await this.getWallet(index_key)
        if (!child.privateKey) {
            throw new Error("Failed to derive private key")
        }

        const privateKeyHex = Buffer.from(child.privateKey).toString("hex")
        const provider = new ethers.JsonRpcProvider(this.RPC)
        const wallet = new ethers.Wallet(privateKeyHex, provider)

        const amountWei = BigInt(Math.floor(amountBNB * 1e18))

        const tx = await wallet.sendTransaction({
            to: toAddress,
            value: amountWei,
        })

        await tx.wait()

        return {
            txHash: tx.hash,
            paid: true,
            amount: amountBNB,
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
        const provider = new ethers.JsonRpcProvider(this.RPC)
        const wallet = new ethers.Wallet(privateKeyHex, provider)

        // BSC USDT usually has 18 decimals
        const amount = BigInt(Math.floor(amountUSDT * 1e18))

        const erc20Abi = [
            "function transfer(address to, uint256 amount) returns (bool)",
        ]

        const contract = new ethers.Contract(BSC_USDT_CONTRACT, erc20Abi, wallet)
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
    ): Promise<PaymentCheckResult> {
        const { startTimeStamp } = options
        switch (currency) {
            case CURRENCY.BNB:
                return await this.getPayStatusBNB(wallet, value, startTimeStamp)
            case CURRENCY.BSC_USDT:
                return await this.getPayStatusToken(wallet, value, startTimeStamp)
            default:
                throw new Error("This currency not implement")
        }
    }

    async getPayStatusBNB(
        wallet: string,
        value: number,
        startTimeStamp: number,
    ): Promise<PaymentCheckResult> {
        await sleep(1000)
        const provider = new ethers.JsonRpcProvider(this.RPC)
        const since = startTimeStamp
        const requiredWei = BigInt(Math.floor(value * 1e18))
        const walletLower = wallet.toLowerCase()

        const balance = await provider.getBalance(walletLower)
        if (balance < requiredWei) return { paid: false }

        const currentBlock = await provider.getBlock("latest")
        if (!currentBlock) return { paid: false }

        const sinceSeconds = Math.floor(since / 1000)
        const elapsedSeconds = currentBlock.timestamp - sinceSeconds
        const estimatedBlocks = Math.ceil(elapsedSeconds / 3) + 20
        const fromBlock = Math.max(0, currentBlock.number - estimatedBlocks)

        for (let i = currentBlock.number; i >= fromBlock; i--) {
            const block = await provider.getBlock(i, true)
            if (!block) continue

            const txs = block.transactions as unknown as ethers.TransactionResponse[]
            for (const tx of txs) {
                if (tx.to?.toLowerCase() === walletLower && tx.value >= requiredWei) {
                    const receipt = await provider.getTransactionReceipt(tx.hash)
                    if (receipt?.status === 1) {
                        return {
                            paid: true,
                            txHash: tx.hash,
                            amount: Number(tx.value) / 1e18,
                        }
                    }
                }
            }

            if (block.timestamp < sinceSeconds) break
        }

        return { paid: false }
    }

    async getPayStatusToken(
        wallet: string,
        value: number,
        startTimeStamp: number,
    ): Promise<PaymentCheckResult> {
        await sleep(1000)
        const provider = new ethers.JsonRpcProvider(this.RPC)
        const since = startTimeStamp
        const requiredAmount = BigInt(Math.floor(value * 1e18))
        const walletLower = wallet.toLowerCase()

        const currentBlock = await provider.getBlock("latest")
        if (!currentBlock) return { paid: false }

        const sinceSeconds = Math.floor(since / 1000)
        const elapsedSeconds = currentBlock.timestamp - sinceSeconds
        const estimatedBlocks = Math.ceil(elapsedSeconds / 3) + 20
        const fromBlock = Math.max(0, currentBlock.number - estimatedBlocks)

        const transferTopic = ethers.id("Transfer(address,address,uint256)")
        const paddedAddress = ethers.zeroPadValue(walletLower, 32)

        const logs = await provider.getLogs({
            address: BSC_USDT_CONTRACT,
            fromBlock,
            toBlock: "latest",
            topics: [transferTopic, null, paddedAddress],
        })

        const iface = new ethers.Interface([
            "event Transfer(address indexed from, address indexed to, uint256 value)",
        ])

        for (const log of logs.reverse()) {
            const parsed = iface.parseLog({
                topics: log.topics as string[],
                data: log.data,
            })
            if (!parsed) continue

            const amount = parsed.args.value
            if (amount >= requiredAmount) {
                const block = await provider.getBlock(log.blockNumber)
                if (block && block.timestamp * 1000 >= since) {
                    return {
                        paid: true,
                        txHash: log.transactionHash,
                        amount: Number(amount) / 1e18,
                    }
                }
            }
        }

        return { paid: false }
    }

    async claim(outgoing_wallet: string, walletCount: number = 10): Promise<void> {
        const provider = new ethers.JsonRpcProvider(this.RPC)
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

            const bnbBalance = await provider.getBalance(wallet.address)
            if (bnbBalance === 0n) continue

            const feeData = await provider.getFeeData()
            const gasPrice = feeData.gasPrice ?? BigInt(1e10)

            // Sweep USDT if any
            const usdtContract = new ethers.Contract(BSC_USDT_CONTRACT, erc20Abi, wallet)
            // @ts-ignore
            const usdtBalance = await usdtContract.balanceOf(wallet.address)
            if (usdtBalance > 0n) {
                // @ts-ignore
                const usdtGasEstimate = await usdtContract.transfer.estimateGas(outgoing_wallet, usdtBalance)
                const usdtGasCost = gasPrice * usdtGasEstimate
                if (bnbBalance > usdtGasCost) {
                    // @ts-ignore
                    const tx = await usdtContract.transfer(outgoing_wallet, usdtBalance)
                    await tx.wait()
                }
            }

            // Sweep remaining BNB
            const remainingBnb = await provider.getBalance(wallet.address)
            const bnbTxGasEstimate = await provider.estimateGas({
                from: wallet.address,
                to: outgoing_wallet,
                value: remainingBnb,
            })
            const bnbTxGasCost = gasPrice * bnbTxGasEstimate
            const reserveWei = BigInt(Math.floor(this.RESERVE_BNB * 1e18))
            const sweepAmount = remainingBnb - bnbTxGasCost - reserveWei
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
        if (!this.MNEMONIC) {
            throw new Error("MNEMONIC is not set")
        }

        const seed = await bip39.mnemonicToSeed(this.MNEMONIC)
        const root = this.bip32Root.fromSeed(seed)
        const derivationIndex = sha256ToIndex(index_key)
        const child = root.derivePath(`${this.DERIVATION_PATH}/${derivationIndex}`)
        return child
    }

    async createAddressFromDerivation(callback_data: string) {
        const child = await this.getWallet(callback_data)
        if (!child.privateKey) {
            throw new Error("Failed to derive private key")
        }

        const privateKeyHex = Buffer.from(child.privateKey).toString("hex")
        const wallet = new ethers.Wallet(privateKeyHex)
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
