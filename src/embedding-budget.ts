// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from './http.js'

const perMinute = 128
const perDay = 8192
const userMinute = 64
const userDay = 4096

export function initEmbeddingBudget(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_embedding_budget (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    minute INTEGER NOT NULL, day INTEGER NOT NULL,
    minute_vectors INTEGER NOT NULL, day_vectors INTEGER NOT NULL
  )`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_embedding_user_budget (
    user_id TEXT PRIMARY KEY, minute INTEGER NOT NULL, day INTEGER NOT NULL,
    minute_vectors INTEGER NOT NULL, day_vectors INTEGER NOT NULL
  )`)
}

type Counters = { minute: number, day: number, minute_vectors: number, day_vectors: number }

export function reserveEmbeddingBudget(storage: DurableObjectStorage, userId: string, count: number): void {
  const sql = storage.sql
  const now = Date.now()
  const minute = Math.floor(now / 60_000)
  const day = Math.floor(now / 86_400_000)
  storage.transactionSync(() => {
    const current = sql.exec<Counters>(
      'SELECT minute, day, minute_vectors, day_vectors FROM ov_edge_embedding_budget WHERE id = 1',
    ).toArray()[0]
    const user = sql.exec<Counters>(
      'SELECT minute, day, minute_vectors, day_vectors FROM ov_edge_embedding_user_budget WHERE user_id = ?', userId,
    ).toArray()[0]
    const minuteVectors = (current?.minute === minute ? current.minute_vectors : 0) + count
    const dayVectors = (current?.day === day ? current.day_vectors : 0) + count
    const userMinuteVectors = (user?.minute === minute ? user.minute_vectors : 0) + count
    const userDayVectors = (user?.day === day ? user.day_vectors : 0) + count
    if (minuteVectors > perMinute || dayVectors > perDay) {
      throw new ApiError(429, 'RATE_LIMITED', 'Embedding budget for this account is exhausted. Try again later.')
    }
    if (userMinuteVectors > userMinute || userDayVectors > userDay) {
      throw new ApiError(429, 'RATE_LIMITED', 'Embedding budget for this user is exhausted. Try again later.')
    }
    sql.exec(`INSERT INTO ov_edge_embedding_budget VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET minute=excluded.minute, day=excluded.day,
      minute_vectors=excluded.minute_vectors, day_vectors=excluded.day_vectors`,
    minute, day, minuteVectors, dayVectors)
    sql.exec(`INSERT INTO ov_edge_embedding_user_budget VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET minute=excluded.minute, day=excluded.day,
      minute_vectors=excluded.minute_vectors, day_vectors=excluded.day_vectors`,
    userId, minute, day, userMinuteVectors, userDayVectors)
  })
}
