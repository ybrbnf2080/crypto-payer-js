import axios from "axios"
import { CreateInvoce, CURRENCY, INVOCE_STATUS, type Invoice } from "../store.ts"
import { sha256ToIndex, } from "../setting.ts"
import TronWeb from "tronweb"
import * as bip39 from "bip39"
import bip32, { BIP32API } from "bip32"
import * as ecc from "tiny-secp256k1"
import { CURRENCY_TYPE, PaymentCheckResult, PaymentProvider } from "./interface.ts"

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

export class TronProvider implements PaymentProvider {

  private bip32Root: BIP32API
  private TRON_DERIVATION_PATH = "m/44'/60'/0'/0"
  private TRON_MNEMONIC: string
  private tronWeb: InstanceType<typeof TronWeb.TronWeb>
  readonly avalibe_currency: CURRENCY_TYPE[] = [CURRENCY.TRX, CURRENCY.USDT_TRC20]
  constructor(TRON_MNEMONIC: string) {
    this.TRON_MNEMONIC = TRON_MNEMONIC
    this.bip32Root = bip32(ecc)
    this.tronWeb = new TronWeb.TronWeb({
      fullHost: "https://api.trongrid.io",
    })
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
      fullHost: "https://api.trongrid.io",
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

    const tronWeb = new TronWeb.TronWeb({
      fullHost: "https://api.trongrid.io",
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
      minutesBack?: number
    }
  ): Promise<PaymentCheckResult> {
    const { minutesBack, token_contract } = options
    switch (currency) {
      case CURRENCY.TRX:
        return await this.getPayStatusTRX(wallet, value, minutesBack)
      case CURRENCY.USDT_TRC20:
        return await this.getPayStatusTRX(wallet, value, minutesBack)

      default:
        throw new Error("This currency not implement")
    }
  }
  async getPayStatusTRX(
    wallet: string,
    value: number,
    minutesBack = 30
  ): Promise<PaymentCheckResult> {
    const since = Date.now() - minutesBack * 60 * 1000
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
        }
      }
    }

    return { paid: false }
  }

  async getPayStatusUSDT(
    wallet: string,
    value: number,
    minutesBack = 30
  ): Promise<PaymentCheckResult> {
    const since = Date.now() - minutesBack * 60 * 1000
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
