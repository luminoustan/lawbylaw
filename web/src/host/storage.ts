/**
 * storage.ts — browser-only chat persistence (IndexedDB, with in-memory fallback).
 *
 * Chats never leave the visitor's browser except as part of an explicit chat
 * request. Handles: IndexedDB unavailable (private mode), quota errors,
 * corrupted records (dropped, never thrown at the UI), and a hard chat cap.
 */

import type { WireMessage } from "../lib/types"

export interface StoredSubagent {
  taskId: string
  callId: string
  title: string
  subagentType: string
  messages: WireMessage[]
}

export interface StoredChat {
  id: string
  title?: string
  createdAt: string
  updatedAt: string
  messages: WireMessage[]
  /** What `/compact` stored: `summary` replaces every message before `afterId` when sending. */
  compaction?: { summary: string; afterId: string }
  /** Read-only transcripts of the research sub-agents this chat launched. */
  subagents?: StoredSubagent[]
}

export const MAX_CHATS = 50
export const MAX_MESSAGES_PER_CHAT = 200
const DB_NAME = "lawbylaw"
const STORE = "chats"
const SCHEMA_VERSION = 1

function isValidChat(v: unknown): v is StoredChat {
  if (!v || typeof v !== "object") return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === "string" &&
    typeof c.createdAt === "string" &&
    typeof c.updatedAt === "string" &&
    Array.isArray(c.messages) &&
    c.messages.every((m) => m && typeof m === "object" && typeof (m as WireMessage).id === "string")
  )
}

export interface ChatStorage {
  /** True when data is only in memory (will be lost on reload). */
  readonly volatile: boolean
  loadAll(): Promise<StoredChat[]>
  save(chat: StoredChat): Promise<void>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

function memoryStorage(): ChatStorage {
  const map = new Map<string, StoredChat>()
  return {
    volatile: true,
    async loadAll() {
      return [...map.values()]
    },
    async save(chat) {
      map.set(chat.id, structuredClone(chat))
    },
    async remove(id) {
      map.delete(id)
    },
    async clear() {
      map.clear()
    },
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return Promise.resolve(db.transaction(STORE, mode).objectStore(STORE))
}

export async function openStorage(onDegraded?: (reason: string) => void): Promise<ChatStorage> {
  if (typeof indexedDB === "undefined") return memoryStorage()
  let db: IDBDatabase
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, SCHEMA_VERSION)
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) {
          open.result.createObjectStore(STORE, { keyPath: "id" })
        }
      }
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
      open.onblocked = () => reject(new Error("blocked"))
      setTimeout(() => reject(new Error("timeout")), 4000)
    })
  } catch {
    onDegraded?.("Your browser blocked local storage, so chats will be lost when you close this tab.")
    return memoryStorage()
  }

  const fallback = memoryStorage()
  let degraded = false
  const degrade = (reason: string) => {
    if (!degraded) {
      degraded = true
      onDegraded?.(reason)
    }
  }

  return {
    get volatile() {
      return degraded
    },
    async loadAll() {
      try {
        const store = await tx(db, "readonly")
        const all = (await req(store.getAll())) as unknown[]
        // Corrupted rows are skipped, never fatal.
        return all.filter(isValidChat)
      } catch {
        return []
      }
    },
    async save(chat) {
      if (degraded) return fallback.save(chat)
      try {
        const store = await tx(db, "readwrite")
        await req(store.put(chat))
      } catch (e) {
        const quota = e instanceof DOMException && e.name === "QuotaExceededError"
        degrade(
          quota
            ? "Browser storage is full. Delete old chats to keep saving."
            : "Couldn't save this chat to your browser.",
        )
        await fallback.save(chat)
      }
    },
    async remove(id) {
      try {
        const store = await tx(db, "readwrite")
        await req(store.delete(id))
      } catch {
        /* ignore */
      }
      await fallback.remove(id)
    },
    async clear() {
      try {
        const store = await tx(db, "readwrite")
        await req(store.clear())
      } catch {
        /* ignore */
      }
      await fallback.clear()
    },
  }
}
