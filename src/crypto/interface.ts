import { CreateInvoce, CURRENCY, Invoice } from "../store"
export type CURRENCY_TYPE = keyof typeof CURRENCY

export interface PaymentCheckResult {
    paid: boolean
    txHash?: string
    amount?: number
    timestamp?: number

}

export interface PaymentProvider {
    /**
     * Валюты, которые поддерживает провайдер
     * Например: ["TRX", "USDT_TRC20"]
     */
    readonly avalibe_currency: readonly CURRENCY_TYPE[]


    /**
     * Создание инвойса (без сохранения в storage)
     */
    getAddressForPay(
        index_key: string,
        currency: CURRENCY_TYPE
    ): Promise<string>


    /**
     * Вывод на кошелек пользователя
     */
    withdraw(
        index_key: number,
        out_wallet: string,
        amount: number,
        currency: CURRENCY_TYPE
    ): Promise<PaymentCheckResult>

    /**
     * Проверка статуса платежа
     */
    getPayStatus(
        wallet: string,
        value: number,
        currency: CURRENCY_TYPE,
        options: {
            token_contract?: string,
            startTimeStamp?: number
        }
    ): Promise<PaymentCheckResult>
}
