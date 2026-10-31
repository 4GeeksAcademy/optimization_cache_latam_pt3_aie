import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Plus, Search, X } from 'lucide-react'
import { getBooks, getStock } from '../api/books'
import { AddBookForm } from '../components/AddBookForm'
import { BookCard } from '../components/BookCard'
import type { Book, StockResult } from '../types'
import { trackError, trackEvent } from '../telemetry'

export function BooksPage() {
  const [books, setBooks] = useState<Book[]>([])
  const [query, setQuery] = useState('')
  const [stockId, setStockId] = useState('')
  const [stockResult, setStockResult] = useState<StockResult | null>(null)
  const [stockError, setStockError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)

  async function loadBooks() {
    setLoading(true)
    setError('')
    try { setBooks(await getBooks()) }
    catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudieron cargar los libros.'
      setError(message)
      trackError({ error_scope: 'data_load', message })
    }
    finally { setLoading(false) }
  }

  useEffect(() => {
    trackEvent('page_viewed', { path: window.location.pathname, page: 'catalog' })
    void loadBooks()
  }, [])

  const filteredBooks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('es')
    if (!normalized) return books
    return books.filter((book) => `${book.title} ${book.author} ${book.genre} ${book.stock_id}`.toLocaleLowerCase('es').includes(normalized))
  }, [books, query])

  async function searchStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStockError('')
    setStockResult(null)
    try { setStockResult(await getStock(stockId.trim())) }
    catch (err) { setStockError(err instanceof Error ? err.message : 'No se encontró el stock.') }
  }

  return (
    <>
      <section className="mb-10 flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-xs font-medium tracking-[0.17em] text-[#74816f] uppercase">Panel de administración</p>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Inventario de libros</h1>
          <p className="mt-2 text-sm text-[#777a72]">Un espacio claro para mantener tu catálogo al día.</p>
        </div>
        <button onClick={() => setShowForm(true)} className="inline-flex items-center justify-center gap-2 self-start rounded-xl bg-[#263d32] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#354f41] sm:self-auto">
          <Plus size={17} /> Añadir libro
        </button>
      </section>

      <section className="mb-8 rounded-2xl border border-[#e8e8e2] bg-white p-5 sm:p-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold">Consultar disponibilidad</h2>
          <p className="mt-1 text-xs text-[#85877f]">Busca las unidades de un libro mediante su ID de stock.</p>
        </div>
        <form onSubmit={searchStock} className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[#999b94]" />
            <input aria-label="ID de stock" required value={stockId} onChange={(e) => setStockId(e.target.value)} placeholder="Por ejemplo, STK-001" className="w-full rounded-xl border border-[#e4e5df] bg-[#fdfdfc] py-3 pr-3 pl-10 text-sm outline-none transition focus:border-[#8b9b88] focus:ring-2 focus:ring-[#dce4d9]" />
          </div>
          <button className="rounded-xl border border-[#dfe1d9] px-5 py-3 text-sm font-medium transition hover:bg-[#f6f7f3]" type="submit">Consultar stock</button>
        </form>
        {stockResult && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#f1f5ef] px-4 py-3 text-sm"><span className="font-medium">{stockResult.title} <span className="font-normal text-[#777a72]">· {stockResult.stock_id}</span></span><span className="font-semibold text-[#3f6948]">{stockResult.stock} {stockResult.stock === 1 ? 'unidad disponible' : 'unidades disponibles'}</span></div>}
        {stockError && <p role="alert" className="mt-3 text-sm text-[#a44d38]">{stockError}</p>}
      </section>

      <section>
        <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div><h2 className="text-lg font-semibold tracking-tight">Catálogo</h2><p className="mt-0.5 text-xs text-[#85877f]">{books.length} {books.length === 1 ? 'título registrado' : 'títulos registrados'}</p></div>
          <label className="relative block sm:w-64"><Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[#999b94]" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar título, autor…" aria-label="Buscar en el catálogo" className="w-full rounded-xl border border-[#e4e5df] bg-white py-2.5 pr-3 pl-9 text-sm outline-none focus:border-[#8b9b88] focus:ring-2 focus:ring-[#dce4d9]" /></label>
        </div>
        {loading && <p className="rounded-xl border border-[#e8e8e2] bg-white p-8 text-center text-sm text-[#777a72]">Cargando catálogo…</p>}
        {error && !loading && <div role="alert" className="rounded-xl bg-[#fff1ed] p-5 text-sm text-[#a44d38]">{error} <button onClick={() => void loadBooks()} className="ml-2 underline">Reintentar</button></div>}
        {!loading && !error && filteredBooks.length > 0 && <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{filteredBooks.map((book) => <BookCard key={book.id} book={book} />)}</div>}
        {!loading && !error && filteredBooks.length === 0 && <div className="rounded-2xl border border-dashed border-[#d9dbd3] px-6 py-12 text-center"><p className="text-sm font-medium">{books.length ? 'No encontramos coincidencias' : 'Aún no hay libros en el catálogo'}</p><p className="mt-1 text-sm text-[#85877f]">{books.length ? 'Prueba con otro título, autor o género.' : 'Añade el primer título para comenzar.'}</p></div>}
      </section>

      {showForm && <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#17221c]/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowForm(false) }}><section role="dialog" aria-modal="true" aria-labelledby="add-book-title" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[#fbfbf9] p-5 shadow-xl sm:p-7"><div className="mb-6 flex items-start justify-between"><div><h2 id="add-book-title" className="text-xl font-semibold tracking-tight">Añadir un libro</h2><p className="mt-1 text-sm text-[#777a72]">El nuevo registro se guardará en el inventario.</p></div><button onClick={() => setShowForm(false)} aria-label="Cerrar" className="rounded-lg p-2 text-[#777a72] hover:bg-[#f0f1ec]"><X size={18} /></button></div><AddBookForm onCancel={() => setShowForm(false)} onCreated={() => { setShowForm(false); void loadBooks() }} /></section></div>}
    </>
  )
}
