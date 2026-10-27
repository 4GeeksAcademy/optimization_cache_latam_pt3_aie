import type { Book, BookInput, StockResult } from '../types'

const API_URL = import.meta.env.VITE_API_URL ?? '/api'
const CACHE_TTL_MS = 60_000

type CacheEntry = { value: unknown; expiresAt: number }
const responseCache = new Map<string, CacheEntry>()
const pendingRequests = new Map<string, Promise<unknown>>()
let cacheGeneration = 0

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.detail ?? 'No se pudo completar la solicitud.')
  }
  return response.json() as Promise<T>
}

async function cachedRequest<T>(path: string): Promise<T> {
  const cached = responseCache.get(path)
  if (cached && cached.expiresAt > Date.now()) return cached.value as T
  if (cached) responseCache.delete(path)

  const pending = pendingRequests.get(path)
  if (pending) return pending as Promise<T>

  const generation = cacheGeneration
  const requestPromise = request<T>(path)
    .then((value) => {
      if (generation === cacheGeneration) {
        responseCache.set(path, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      }
      return value
    })
    .finally(() => {
      if (pendingRequests.get(path) === requestPromise) pendingRequests.delete(path)
    })

  pendingRequests.set(path, requestPromise)
  return requestPromise
}

function invalidateBooksCache() {
  cacheGeneration += 1
  responseCache.clear()
  pendingRequests.clear()
}

export const getBooks = () => cachedRequest<Book[]>('/books')
export const getBook = (id: number) => cachedRequest<Book>(`/book/${id}`)
export const getStock = (stockId: string) =>
  cachedRequest<StockResult>(`/book/stock/${encodeURIComponent(stockId)}`)

export async function createBook(book: BookInput): Promise<Book> {
  const createdBook = await request<Book>('/book', {
    method: 'POST',
    body: JSON.stringify(book),
  })
  invalidateBooksCache()
  return createdBook
}
