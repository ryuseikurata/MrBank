import { firestore } from 'firebase-admin'
import * as Transfer from '../../models/Transfer'
import { TransactionType } from '../../models/Core'
import { Configuration } from '../../models/Configuration'
import { ShardType, randomShard, DafaultShardCharacters } from '../../util/Shard'
import { rootRef, getTransactionRef } from '../helper'
import { DEFAULT_EXPIRE_TIME } from '../../config'
import * as Dayjs from 'dayjs'

export default class TransferController {

	static async request<Request extends Transfer.Request>(data: Request) {
		const amount = data.amount
		const fromRef = rootRef().collection('accounts').doc(data.from)
		const authorizationCollectionRef = fromRef.collection('authorizations')
		const transactionRef = authorizationCollectionRef.doc()
		const toRef = rootRef().collection('accounts').doc(data.to)
		const now = Dayjs(firestore.Timestamp.now().toDate())
		const year = now.year()
		const month = now.month()
		const date = now.date()
		const expire = now.add(DEFAULT_EXPIRE_TIME, 'second').toDate()
		const shard = randomShard(DafaultShardCharacters)
		const toConfigurationSnapshot = await rootRef().collection('configurations').doc(data.to).get()
		const toConfiguration = toConfigurationSnapshot.data() as Configuration | undefined
		const toShardCharcters = toConfiguration?.shardCharacters || DafaultShardCharacters
		try {
			await firestore().runTransaction(async transaction => {
				const [authorizationSnapshot, fromAccount, toAccount] = await Promise.all([
					authorizationCollectionRef
					.where('expireTime', '>', firestore.Timestamp.now())
					.where('isConfirmed', '==', false)
					.get(),
					transaction.get(fromRef),
					transaction.get(toRef)
				])
				if (authorizationSnapshot.docs.length > 0) {
					console.log(authorizationSnapshot.docs)
					throw new Error(`Already requested. authorization id: ${authorizationSnapshot.docs[0].ref.path}`)
				}
				const fromAccountData = fromAccount.data()
				const toAccountData = toAccount.data()
				if (!fromAccountData) {
					throw new Error(`This account is not available. uid: ${data.from}`)
				}
				if (!toAccountData) {
					throw new Error(`This account is not available. uid: ${data.to}`)
				}
				if (!fromAccountData.isAvailable) {
					throw new Error(`This account is not available. uid: ${data.from}`)
				}
				if (!toAccountData.isAvailable) {
					throw new Error(`This account is not available. uid: ${data.to}`)
				}
				const snapshot = await transaction.get(fromRef.collection("balances").doc(data.currency).collection(`shards`))
				const currentAmount = snapshot.docs.reduce((prev, current) => {
					const data = (current.data() || { amount: 0 })
					const amount = data.amount
					return prev + amount
				}, 0)
				if (currentAmount < amount) {
					throw new Error(`Out of balance. ${currentAmount}`)
				}
				const documentData: Transfer.Authorization = {
					...data,
					year, month, date,
					shard,
					toShardCharacters: toShardCharcters,
					isConfirmed: false,
					expireTime: firestore.Timestamp.fromDate(expire)
				}
				transaction.set(transactionRef, documentData, { merge: true })
			})
			return transactionRef.id
		} catch (error) {
			throw error
		}
	}

	static async confirm(from: string, authorizationID: string) {
		const fromRef = rootRef().collection('accounts').doc(from)
		const ref = fromRef.collection('authorizations').doc(authorizationID)
		const type: TransactionType = 'transfer'
		try {
			const result = await firestore().runTransaction(async transaction => {
				const tran = await transaction.get(ref)
				if (!tran) {
					throw new Error(`This transaction is not available. id: ${ref.id}`)
				}
				const data = tran.data() as Transfer.Authorization | undefined
				if (!data) {
					throw new Error(`This transaction is not data. id: ${ref.id}`)
				}
				if (data.isConfirmed) {
					throw new Error(`This transaction is already confirmed. id: ${ref.id}`)
				}
				const { expireTime, amount, toShardCharacters } = data
				const timestamp = firestore.Timestamp.now()
				if (expireTime.toDate() < timestamp.toDate()) {
					throw new Error(`This request has expired. id: ${ref.id}`)
				}
				const dayjs = Dayjs(timestamp.toDate())
				const year = dayjs.year()
				const month = dayjs.month()
				const date = dayjs.date()
				const toRef = rootRef().collection('accounts').doc(data.to)
				const fromTransactionRef = getTransactionRef(fromRef, ref.id, year, month, date)
				const toTransactionRef = getTransactionRef(toRef, ref.id, year, month, date)
				const currencyRef = fromRef.collection("balances").doc(data.currency)
				const snapshot = await currencyRef.collection(`shards`).where('amount', '>=', 100).get()
				if (snapshot.docs.length === 0) {
					throw new Error(`Out of balance. ${fromRef.path}`)
				}
				const IDs = snapshot.docs.map(doc => doc.id) as ShardType[]

				// amount
				const fromShard = randomShard(IDs)
				const toShard = randomShard(toShardCharacters)
				const from = currencyRef.collection(`shards`).doc(fromShard)
				const to = toRef.collection("balances").doc(data.currency).collection(`shards`).doc(toShard)
				const fromSnapshot = await transaction.get(from)
				const toSnapshot = await transaction.get(to)
				const fromData = fromSnapshot.data() || { amount: 0 }
				const toData = toSnapshot.data() || { amount: 0 }
				const fromAmount = fromData.amount - amount
				const toAmount = toData.amount + amount

				// transaction
				const fromTransaction: Transfer.Transaction = {
					type,
					shard: fromShard,
					from: data.from,
					to: data.to,
					currency: data.currency,
					amount: data.amount,
					createTime: firestore.FieldValue.serverTimestamp(),
					updateTime: firestore.FieldValue.serverTimestamp()
				}
				const toTransaction: Transfer.Transaction = {
					type,
					shard: toShard,
					from: data.from,
					to: data.to,
					currency: data.currency,
					amount: data.amount,
					createTime: firestore.FieldValue.serverTimestamp(),
					updateTime: firestore.FieldValue.serverTimestamp()
				}
				transaction.set(tran.ref, { isConfirmed: true }, { merge: true })
				transaction.set(from, { amount: fromAmount }, { merge: true })
				transaction.set(to, { amount: toAmount }, { merge: true })
				transaction.set(fromTransactionRef, fromTransaction)
				transaction.set(toTransactionRef, toTransaction)
				return {
					type,
					from: data.from,
					to: data.to,
					currency: data.currency,
					amount: data.amount
				}
			})
			return result
		} catch (error) {
			throw error
		}
	}
}
