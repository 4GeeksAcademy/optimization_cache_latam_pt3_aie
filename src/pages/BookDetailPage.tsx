import { useEffect, useState } from 'react'
import { ArrowLeft, BookOpen, PackageCheck } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { getBook } from '../api/books'
import type { Book } from '../types'
import { trackError, trackEvent } from '../telemetry'

export function BookDetailPage() {
  const { id } = useParams()
  const [book, setBook] = useState<Book | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const validId = !!id && /^\d+$/.test(id) && Number(id) > 0
    trackEvent('page_viewed', { path: window.location.pathname, page: 'book_detail', book_id: validId ? Number(id) : null })
    if (!validId) {
      const message = 'El identificador del libro no es válido.'
      setError(message)
      trackError({ error_scope: 'route', message })
      return
    }
    getBook(Number(id))
      .then((loaded) => {
        setBook(loaded)
        trackEvent('book_detail_viewed', { book_id: loaded.id, genre: loaded.genre, list_position: null, has_stock: loaded.stock > 0 })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'No se pudo cargar el libro.'
        setError(message)
        trackError({ error_scope: 'data_load', message })
      })
  }, [id])

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm text-[#6f746b] transition hover:text-[#263d32]"><ArrowLeft size={16} /> Volver al catálogo</Link>
      {error && <div role="alert" className="rounded-2xl bg-[#fff1ed] p-6 text-sm text-[#a44d38]">{error}</div>}
      {!error && !book && <p className="rounded-2xl border border-[#e8e8e2] bg-white p-8 text-center text-sm text-[#777a72]">Cargando detalle…</p>}
      {book && <article className="overflow-hidden rounded-3xl border border-[#e8e8e2] bg-white">
        <div className="bg-[#edf0e9] px-7 py-10 sm:px-10 sm:py-14">
          <span className="mb-6 grid size-14 place-items-center rounded-2xl bg-white text-[#45634d]"><BookOpen size={24} strokeWidth={1.6} /></span>
          <p className="mb-2 text-xs font-medium tracking-[0.16em] text-[#74816f] uppercase">{book.genre}</p>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">{book.title}</h1>
          <p className="mt-3 text-lg text-[#70756c]">{book.author}</p>
        </div>
        <div className="grid gap-6 p-7 sm:grid-cols-3 sm:p-10">
          <div><p className="text-xs text-[#85877f]">Año de publicación</p><p className="mt-2 font-medium">{book.year ?? 'No especificado'}</p></div>
          <div><p className="text-xs text-[#85877f]">ID de stock</p><p className="mt-2 font-mono font-medium">{book.stock_id}</p></div>
          <div><p className="text-xs text-[#85877f]">Existencias</p><p className="mt-2 flex items-center gap-2 font-medium"><PackageCheck size={17} className={book.stock > 0 ? 'text-[#52785a]' : 'text-[#ad694e]'} />{book.stock} {book.stock === 1 ? 'unidad' : 'unidades'}</p></div>
        </div>
      </article>}
    </div>
  )
}
