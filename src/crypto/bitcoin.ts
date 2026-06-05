import axios from "axios"
import { CURRENCY_TYPE, PaymentCheckResult, PaymentProvider } from "./interface.ts"
import { CURRENCY } from "../store.ts"
import * as bip39 from "bip39"
import bip32, { BIP32API } from "bip32"
import * as ecc from "tiny-secp256k1"
import { sha256ToIndex } from "../setting.ts"
import { sleep } from "tronweb/utils"
import * as bitcoin from "bitcoinjs-lib"

try {
    if (typeof (bitcoin as any).initEccLib === 'function') {
        (bitcoin as any).initEccLib(ecc)
    }
} catch { }

const BITCOIN_DERIVATION_PATH = "m/84'/0'/0'/0"
const BLOCKSTREAM_API = "https://blockstream.info/api"

interface BtcUtxo {
    txid: string
    vout: number
    value: number
    status: {
        confirmed: boolean
        block_height?: number
    }
}

interface BtcTxVout {
    scriptpubkey_address?: string
    value: number
}

interface BtcTx {
    txid: string
    vout: BtcTxVout[]
    status: {
        confirmed: boolean
        block_time?: number
    }
}

export class BitcoinProvider implements PaymentProvider {
    private bip32Root: BIP32API
    private MNEMONIC: string
    readonly avalibe_currency: CURRENCY_TYPE[] = [CURRENCY.BTC]

    constructor(MNEMONIC: string) {
        this.MNEMONIC = MNEMONIC
        this.bip32Root = bip32(ecc)
    }

    async withdraw(index_key: number, out_wallet: string, amount: number, currency: CURRENCY_TYPE): Promise<PaymentCheckResult> {
        if (currency !== CURRENCY.BTC) throw new Error("currency not supported")
        return await this.withdrawBTC(String(index_key), out_wallet, amount)
    }

    async withdrawBTC(
        index_key: string,
        toAddress: string,
        amountBTC: number
    ): Promise<PaymentCheckResult> {
        const child = await this.getWallet(index_key)
        if (!child.privateKey) throw new Error("Failed to derive private key")

        const fromAddress = await this.createAddressFromDerivation(index_key)

        const { data: utxos } = await axios.get<BtcUtxo[]>(
            `${BLOCKSTREAM_API}/address/${fromAddress}/utxo`
        )

        if (utxos.length === 0) throw new Error("No UTXOs available")

        const amountSats = Math.floor(amountBTC * 1e8)
        let totalInput = 0
        const selectedUtxos: BtcUtxo[] = []

        for (const utxo of utxos) {
            selectedUtxos.push(utxo)
            totalInput += utxo.value
            if (totalInput >= amountSats + 10000) break
        }

        if (totalInput < amountSats) throw new Error("Insufficient funds")

        let feeRate = 10
        try {
            const { data: fees } = await axios.get<Record<string, number>>(`${BLOCKSTREAM_API}/fee-estimates`)
            if (fees["3"]) feeRate = Math.ceil(fees["3"])
        } catch { }

        const pubkey = Buffer.from(child.publicKey)
        const { output } = bitcoin.payments.p2wpkh({ pubkey })
        if (!output) throw new Error("Failed to derive output script")

        const psbt = new bitcoin.Psbt()
        for (const utxo of selectedUtxos) {
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                witnessUtxo: {
                    script: output,
                    value: utxo.value,
                },
            })
        }

        psbt.addOutput({ address: toAddress, value: amountSats })

        const change = totalInput - amountSats
        const txVirtualSize = 10 + 68 * selectedUtxos.length + 31 * 2
        const fee = Math.ceil(txVirtualSize * feeRate)
        const finalChange = change - fee

        if (finalChange > 546) {
            psbt.addOutput({ address: fromAddress, value: finalChange })
        }

        const pubkeyBuf = Buffer.from(child.publicKey)
        for (let i = 0; i < selectedUtxos.length; i++) {
            psbt.signInput(i, {
                publicKey: pubkeyBuf,
                sign: (hash: Buffer) => Buffer.from(child.sign(hash)),
            })
        }

        psbt.finalizeAllInputs()
        const tx = psbt.extractTransaction()
        const txHex = tx.toHex()

        const { data: txid } = await axios.post<string>(`${BLOCKSTREAM_API}/tx`, txHex, {
            headers: { "Content-Type": "text/plain" },
        })

        return {
            txHash: txid,
            paid: true,
            amount: amountBTC,
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
        if (currency !== CURRENCY.BTC) throw new Error("This currency not implement")
        return await this.getPayStatusBTC(wallet, value, options.startTimeStamp)
    }

    async getPayStatusBTC(
        wallet: string,
        value: number,
        startTimeStamp: number
    ): Promise<PaymentCheckResult> {
        await sleep(1000)
        const since = startTimeStamp
        const requiredSats = Math.floor(value * 1e8)

        const { data } = await axios.get<BtcTx[]>(
            `${BLOCKSTREAM_API}/address/${wallet}/txs`
        )

        for (const tx of data) {
            const txTime = tx.status.block_time ? tx.status.block_time * 1000 : 0
            if (txTime < since) continue

            for (const output of tx.vout) {
                if (
                    output.scriptpubkey_address === wallet &&
                    output.value >= requiredSats
                ) {
                    return {
                        paid: true,
                        txHash: tx.txid,
                        amount: output.value / 1e8,
                    }
                }
            }
        }

        return { paid: false }
    }

    async claim(outgoing_wallet: string, walletCount: number = 10): Promise<void> {
        for (let i = 0; i < walletCount; i++) {
            await sleep(1000)
            try {
                const child = await this.getWallet(String(i))
                if (!child.privateKey) continue

                const fromAddress = await this.createAddressFromDerivation(String(i))
                const { data: utxos } = await axios.get<BtcUtxo[]>(
                    `${BLOCKSTREAM_API}/address/${fromAddress}/utxo`
                )
                if (utxos.length === 0) continue

                const pubkey = Buffer.from(child.publicKey)
                const { output } = bitcoin.payments.p2wpkh({ pubkey })
                if (!output) continue

                let totalValue = 0
                for (const utxo of utxos) totalValue += utxo.value

                const psbt = new bitcoin.Psbt()
                for (const utxo of utxos) {
                    psbt.addInput({
                        hash: utxo.txid,
                        index: utxo.vout,
                        witnessUtxo: {
                            script: output,
                            value: utxo.value,
                        },
                    })
                }

                const txVirtualSize = 10 + 68 * utxos.length + 31
                let feeRate = 10
                try {
                    const { data: fees } = await axios.get<Record<string, number>>(`${BLOCKSTREAM_API}/fee-estimates`)
                    if (fees["3"]) feeRate = Math.ceil(fees["3"])
                } catch { }

                const fee = Math.ceil(txVirtualSize * feeRate)
                const sweepAmount = totalValue - fee
                if (sweepAmount <= 546) continue

                psbt.addOutput({ address: outgoing_wallet, value: sweepAmount })

                const pubkeyBuf = Buffer.from(child.publicKey)
                for (let j = 0; j < utxos.length; j++) {
                    psbt.signInput(j, {
                        publicKey: pubkeyBuf,
                        sign: (hash: Buffer) => Buffer.from(child.sign(hash)),
                    })
                }

                psbt.finalizeAllInputs()
                const tx = psbt.extractTransaction()
                const txHex = tx.toHex()

                await axios.post(`${BLOCKSTREAM_API}/tx`, txHex, {
                    headers: { "Content-Type": "text/plain" },
                })
            } catch (e) {
                console.error(`BTC claim error for wallet ${i}:`, e)
            }
        }
    }

    async getWallet(index_key: string) {
        if (!this.MNEMONIC) throw new Error("MNEMONIC is not set")
        const seed = await bip39.mnemonicToSeed(this.MNEMONIC)
        const root = this.bip32Root.fromSeed(seed)
        const derivationIndex = sha256ToIndex(index_key)
        const child = root.derivePath(`${BITCOIN_DERIVATION_PATH}/${derivationIndex}`)
        return child
    }

    async createAddressFromDerivation(index_key: string) {
        const child = await this.getWallet(index_key)
        if (!child.privateKey) throw new Error("Failed to derive private key")
        const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey) })
        if (!address) throw new Error("Failed to derive address")
        return address
    }

    async getAddressForPay(
        index_key: string,
        currency: CURRENCY_TYPE
    ): Promise<string> {
        if (!this.avalibe_currency.includes(currency)) throw new Error("This currency not implement")
        return await this.createAddressFromDerivation(index_key)
    }
}
