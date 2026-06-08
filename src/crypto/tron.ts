import axios from "axios"
import { CreateInvoce, CURRENCY, INVOCE_STATUS, type Invoice } from "../store.ts"
import { sha256ToIndex, } from "../setting.ts"
import TronWeb from "tronweb"
import * as bip39 from "bip39"
import bip32, { BIP32API } from "bip32"
import * as ecc from "tiny-secp256k1"
import { CURRENCY_TYPE, PaymentCheckResult, PaymentProvider } from "./interface.ts"
import { sleep } from "tronweb/utils"


const TRONSCAN_API = "https://apilist.tronscan.org/api/transaction"
const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
interface TronTx {
  hash: string
  confirmed: boolean
  contractType: number
  toAddress: string
  ownerAddress: string
  amount: number
  timestamp: number
}
const TOKEN_ABI = [
  {
    'outputs': [{ 'type': 'uint256' }],
    'constant': true,
    'inputs': [{ 'name': 'who', 'type': 'address' }],
    'name': 'balanceOf',
    'stateMutability': 'View',
    'type': 'Function'
  },
  {
    'outputs': [{ 'type': 'bool' }],
    'inputs': [
      { 'name': '_to', 'type': 'address' },
      { 'name': '_value', 'type': 'uint256' }
    ],
    'name': 'transfer',
    'stateMutability': 'Nonpayable',
    'type': 'Function'
  }
];

const TRON_ENERGY_API_BASE = "https://api.tronenergyrent.com"
const USDT_ENERGY_AMOUNT = 65000
const USDT_ENERGY_NEW_WALLET_AMOUNT = 131000
const ENERGY_POLL_INTERVAL = 2000
const ENERGY_POLL_TIMEOUT = 30000

export class TronProvider implements PaymentProvider {

  private bip32Root: BIP32API
  private TRON_DERIVATION_PATH: string
  private TRON_MNEMONIC: string
  private TRON_RESERVE_TRX: number
  private TRON_RPC_HOST: string
  private tronWeb: InstanceType<typeof TronWeb.TronWeb>
  private tronEnergyApiKey: string | null
  readonly avalibe_currency: CURRENCY_TYPE[] = [CURRENCY.TRX, CURRENCY.USDT_TRC20]
  constructor(TRON_MNEMONIC: string, TRON_RESERVE_TRX: number = 1, TRON_RPC_HOST: string = "https://tron.api.pocket.network", TRON_DERIVATION_PATH: string = "m/44'/195'/0'/0", TRON_ENERGY_API_KEY?: string) {
    this.TRON_MNEMONIC = TRON_MNEMONIC
    this.TRON_RESERVE_TRX = TRON_RESERVE_TRX
    this.TRON_DERIVATION_PATH = TRON_DERIVATION_PATH
    this.bip32Root = bip32(ecc)
    this.TRON_RPC_HOST = TRON_RPC_HOST
    this.tronWeb = new TronWeb.TronWeb({
      fullHost: TRON_RPC_HOST,
    })
    this.tronEnergyApiKey = TRON_ENERGY_API_KEY || null
  }

  private async ensureEnergy(address: string, requiredEnergy: number = USDT_ENERGY_AMOUNT): Promise<void> {
    if (!this.tronEnergyApiKey) return

    try {
      const priceUrl = `${TRON_ENERGY_API_BASE}/calculate-energy-price?period=1h&energyAmount=${requiredEnergy}`
      const { data: priceData } = await axios.get(priceUrl)
      if (priceData?.status !== "SUCCESS") return
    } catch {
      return
    }

    const orderUrl = `${TRON_ENERGY_API_BASE}/place-energy-order`
    const { data: orderData } = await axios.get(orderUrl, {
      params: {
        apiKey: this.tronEnergyApiKey,
        period: "1h",
        energyAmount: requiredEnergy,
        destinationAddress: address,
        preActivateDestinationAddress: 0,
      },
    })

    if (orderData?.status !== "SUCCESS") return

    const orderId = orderData.payload?.orderId
    if (!orderId) return

    const deadline = Date.now() + ENERGY_POLL_TIMEOUT
    while (Date.now() < deadline) {
      await sleep(ENERGY_POLL_INTERVAL)
      const { data: statusData } = await axios.get(`${TRON_ENERGY_API_BASE}/single-order-details`, {
        params: {
          apiKey: this.tronEnergyApiKey,
          orderId,
        },
      })

      if (statusData?.status !== "SUCCESS") return

      const state = statusData.payload?.state
      if (state === "ENERGY_DELEGATED") return
      if (state === "ERROR_DELEGATION" || state === "CANCELLED") return
    }
  }

  async withdraw(index_key: number, out_wallet: string, amount: number, currency: CURRENCY_TYPE) {
    switch (currency) {
      case CURRENCY.TRX:
        return await this.withdrawTRX(String(index_key), out_wallet, amount)
      case CURRENCY.USDT_TRC20:
        return await this.withdrawUSDT(String(index_key), out_wallet, amount)

      default:
        throw new Error("This currency not implement")
    }
  }


  async withdrawTRX(
    index_key: string,
    toAddress: string,
    amountTRX: number
  ): Promise<PaymentCheckResult> {
    const { privateKey, address } = await this.getAccount(index_key)
    const tronWeb = new TronWeb.TronWeb({
      fullHost: this.TRON_RPC_HOST,
      privateKey: privateKey
    })

    const amountSun = tronWeb.toSun(amountTRX)

    const tx = await tronWeb.transactionBuilder.sendTrx(
      toAddress,
      // anything string processing
      amountSun as unknown as number,
      address
    )

    const signedTx = await tronWeb.trx.sign(tx, privateKey)
    const result = await tronWeb.trx.sendRawTransaction(signedTx)

    if (!result.result) {
      throw new Error(`TRX transfer failed ${JSON.stringify(result)}`)
    }

    return {
      txHash: result.txid,
      paid: true,
      amount: amountTRX
    }

  }


  async withdrawUSDT(
    index_key: string,
    toAddress: string,
    amountUSDT: number
  ): Promise<PaymentCheckResult> {
    const { privateKey, address } = await this.getAccount(index_key)

    await this.ensureEnergy(address)

    const tronWeb = new TronWeb.TronWeb({
      fullHost: this.TRON_RPC_HOST,
      privateKey: privateKey
    })


    const contract = tronWeb.contract(TOKEN_ABI, USDT_TRC20_CONTRACT)

    // USDT имеет 6 знаков
    const amount = Math.floor(amountUSDT * 1_000_000)


    const txID = await contract
      .transfer(toAddress, amount)
      .send({
        feeLimit: 100_000_000,
        callValue: 0,
        shouldPollResponse: false,
      })


    let tx = await tronWeb.trx.getTransactionInfo(txID);
    if (tx?.result == "FAILED") {
      throw new Error(`withdraw Failed ${txID}`)
    }


    return {
      txHash: txID,
      paid: true,
      amount: amountUSDT
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
    const { startTimeStamp, token_contract } = options
    switch (currency) {
      case CURRENCY.TRX:
        return await this.getPayStatusTRX(wallet, value, startTimeStamp)
      case CURRENCY.USDT_TRC20:
        return await this.getPayStatusUSDT(wallet, value, startTimeStamp)

      default:
        throw new Error("This currency not implement")
    }
  }
  async getPayStatusTRX(
    wallet: string,
    value: number,
    startTimeStamp: number
  ): Promise<PaymentCheckResult> {
    await sleep(1000)
    const since = startTimeStamp
    const requiredSun = value * 1_000_000

    const { data } = await axios.get(TRONSCAN_API, {
      params: {
        sort: "-timestamp",
        count: true,
        limit: 50,
        address: wallet,
      },
    })

    const txs: TronTx[] = data.data ?? []

    for (const tx of txs) {
      if (
        tx.confirmed &&
        tx.contractType === 1 && // TransferContract
        tx.toAddress === wallet &&
        tx.amount >= requiredSun &&
        tx.timestamp >= since
      ) {
        return {
          paid: true,
          txHash: tx.hash,
          amount: tx.amount / 1_000_000,
          timestamp: tx.timestamp
        }
      }
    }

    return { paid: false }
  }

  async getPayStatusUSDT(
    wallet: string,
    value: number,
    startTimeStamp: number
  ): Promise<PaymentCheckResult> {
    await sleep(1000)
    const since = startTimeStamp
    const required = value * 1_000_000 // USDT decimals

    const { data } = await axios.get(
      `https://api.trongrid.io/v1/accounts/${wallet}/transactions/trc20`,
      {
        params: {
          limit: 50,
          only_confirmed: true,
          contract_address: USDT_TRC20_CONTRACT, // USDT
        },
      }
    )

    const txs = data.data ?? []

    for (const tx of txs) {
      const amount = Number(tx.value)

      if (
        tx.to === wallet &&
        amount >= required &&
        tx.block_timestamp >= since
      ) {
        return {
          paid: true,
          txHash: tx.transaction_id,
          amount: amount / 1_000_000,
          timestamp: tx.timestamp

        }
      }
    }

    return { paid: false }
  }


  async getWallet(index_key: string) {
    if (!this.TRON_MNEMONIC) {
      throw new Error("TRON_TRON_MNEMONIC is not set")
    }

    const seed = await bip39.mnemonicToSeed(this.TRON_MNEMONIC)
    const root = this.bip32Root.fromSeed(seed)


    const derivationIndex = sha256ToIndex(index_key)


    const child = root.derivePath(
      `${this.TRON_DERIVATION_PATH}/${derivationIndex}`
    )
    return child
  }

  private async getAccount(index_key: string) {
    const node = await this.getWallet(index_key)
    if (!node.privateKey) {
      throw new Error("Failed to derive private key")
    }

    const privateKey = Buffer.from(node.privateKey).toString("hex")
    const address = this.tronWeb.address.fromPrivateKey(privateKey)
    if (!address) {
      throw new Error("Failed to derive address")

    }

    return { privateKey, address }
  }

  // CREATE INVOCES
  async createAddresFromDerivation(index_key: string) {
    const child = await this.getWallet(index_key)
    if (!child.privateKey) {
      throw new Error("Failed to derive private key")
    }

    const privateKeyHex = Buffer.from(child.privateKey).toString("hex")

    const address = this.tronWeb.address.fromPrivateKey(privateKeyHex)
    if (!address) {
      throw new Error("Cant create wallet")
    }
    return address
  }

  async claim(outgoing_wallet: string, walletCount: number = 10): Promise<void> {
    for (let i = 0; i < walletCount; i++) {
      try {
        await sleep(1000)
        const { privateKey, address } = await this.getAccount(String(i))

        const tronWeb = new TronWeb.TronWeb({
          fullHost: this.TRON_RPC_HOST,
          privateKey: privateKey
        })

        const trxBalance = await tronWeb.trx.getBalance(address)
        if (trxBalance === 0) continue

        const contract = tronWeb.contract(TOKEN_ABI, USDT_TRC20_CONTRACT)
        const usdtBalance = await contract.balanceOf(address).call()

        if (usdtBalance > 0 && trxBalance > 100_000_000) {
          await this.ensureEnergy(address)
          try {
            const txID = await contract
              .transfer(outgoing_wallet, usdtBalance)
              .send({
                feeLimit: 100_000_000,
                callValue: 0,
                shouldPollResponse: false,
              })

            const tx = await tronWeb.trx.getTransactionInfo(txID)
            if (tx?.result == "FAILED") {
              console.error(`USDT claim failed for wallet ${i}: ${txID}`)
            }
          } catch (e) {
            console.error(`USDT claim error for wallet ${i}:`, e)
          }
        }

        const remainingTrx = await tronWeb.trx.getBalance(address)
        const txFeeEstimate = 200_000 // ~0.2 TRX for bandwidth/energy
        const reserveSun = Math.floor(this.TRON_RESERVE_TRX * 1_000_000)
        const sweepAmount = remainingTrx - txFeeEstimate - reserveSun

        if (sweepAmount > 0) {
          try {
            const tx = await tronWeb.transactionBuilder.sendTrx(
              outgoing_wallet,
              sweepAmount as unknown as number,
              address
            )
            const signedTx = await tronWeb.trx.sign(tx, privateKey)
            const result = await tronWeb.trx.sendRawTransaction(signedTx)
            if (!result.result) {
              console.error(`TRX claim failed for wallet ${i}: ${JSON.stringify(result)}`)
            }
          } catch (e) {
            console.error(`TRX claim error for wallet ${i}:`, e)
          }
        }

      } catch (error) {
        console.error(error)
      }
    }
  }

  async getAddressForPay(
    index_key: string,
    currency: CURRENCY_TYPE
  ) {
    if (!this.avalibe_currency.includes(currency)) {
      throw new Error("This currency not implement")
    }
    return await this.createAddresFromDerivation(index_key)

  }

}
