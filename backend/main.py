from __future__ import annotations

import json
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi_cache import FastAPICache
from fastapi_cache.backends.inmemory import InMemoryBackend
from fastapi_cache.decorator import cache
from pydantic import BaseModel, Field


DATA_FILE = Path(__file__).with_name("books.json")
_data_lock = Lock()


class BookCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    author: str = Field(min_length=1, max_length=160)
    genre: str = Field(min_length=1, max_length=100)
    year: int | None = Field(default=None, ge=0, le=2100)
    stock_id: str = Field(min_length=1, max_length=80)
    stock: int = Field(ge=0)


class Book(BookCreate):
    id: int


def _read_books() -> list[dict]:
    if not DATA_FILE.exists():
        return []
    with DATA_FILE.open("r", encoding="utf-8") as file:
        return json.load(file)


def _write_books(books: list[dict]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(
        prefix="books-", suffix=".json", dir=DATA_FILE.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(books, file, ensure_ascii=False, indent=2)
            file.write("\n")
        os.replace(temporary_path, DATA_FILE)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


@asynccontextmanager
async def lifespan(app: FastAPI):
    FastAPICache.init(InMemoryBackend(), prefix="bookstore-cache")
    yield


app = FastAPI(title="Bookstore Inventory API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/books", response_model=list[Book])
@cache(expire=60, namespace="books")
def list_books() -> list[dict]:
    with _data_lock:
        return _read_books()


@app.get("/book/stock/{stock_id}")
@cache(expire=60, namespace="books")
def get_book_stock(stock_id: str) -> dict:
    with _data_lock:
        book = next((item for item in _read_books() if item["stock_id"] == stock_id), None)
    if book is None:
        raise HTTPException(status_code=404, detail="No se encontró un libro con ese stock_id")
    return {"book_id": book["id"], "title": book["title"], "stock_id": book["stock_id"], "stock": book["stock"]}


@app.get("/book/{book_id}", response_model=Book)
@cache(expire=60, namespace="books")
def get_book(book_id: int) -> dict:
    with _data_lock:
        book = next((item for item in _read_books() if item["id"] == book_id), None)
    if book is None:
        raise HTTPException(status_code=404, detail="Libro no encontrado")
    return book


@app.post("/book", response_model=Book, status_code=201)
async def create_book(book_data: BookCreate) -> dict:
    payload = book_data.model_dump()
    with _data_lock:
        books = _read_books()
        if any(item["stock_id"] == payload["stock_id"] for item in books):
            raise HTTPException(status_code=409, detail="El stock_id ya existe")
        new_book = {"id": max((item["id"] for item in books), default=0) + 1, **payload}
        books.append(new_book)
        _write_books(books)
    await FastAPICache.clear(namespace="books")
    return new_book
