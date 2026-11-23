/**
 * In-memory stand-in for the MongoDB driver, used ONLY by the Phase 3 tests
 * (tests/phase3). Product code never imports this file.
 *
 * It implements the small part of the driver API the handlers under test use:
 * find/findOne/insertOne/updateOne/deleteOne/findOneAndUpdate/countDocuments/
 * createIndex/createSearchIndex/listSearchIndexes, plus chainable
 * find().sort().limit().toArray(). Query matching covers plain equality
 * (ObjectId-aware), $exists, $size, $in and dotted field paths.
 */
'use strict'

const { ObjectId } = require('mongodb')

function isObjectId(value) {
  return value != null && typeof value === 'object' && value._bsontype === 'ObjectId'
}

function getPath(doc, path) {
  const parts = String(path).split('.')
  let current = doc
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function setPath(doc, path, value) {
  const parts = String(path).split('.')
  let current = doc
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {}
    }
    current = current[parts[i]]
  }
  current[parts[parts.length - 1]] = value
}

function deletePath(doc, path) {
  const parts = String(path).split('.')
  let current = doc
  for (let i = 0; i < parts.length - 1; i++) {
    if (current == null) return
    current = current[parts[i]]
  }
  if (current != null) delete current[parts[parts.length - 1]]
}

function valuesEqual(a, b) {
  if (isObjectId(a) || isObjectId(b)) return String(a) === String(b)
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  return a === b
}

function matchesOperator(value, operator) {
  if (operator && typeof operator === 'object' && !Array.isArray(operator)) {
    if ('$exists' in operator) {
      const exists = value !== undefined
      return operator.$exists ? exists : !exists
    }
    if ('$size' in operator) {
      return Array.isArray(value) && value.length === operator.$size
    }
    if ('$in' in operator) {
      return Array.isArray(operator.$in) && operator.$in.some((v) => valuesEqual(value, v))
    }
    if ('$ne' in operator) return !valuesEqual(value, operator.$ne)
    if ('$gt' in operator) return compareForRange(value, operator.$gt) > 0
    if ('$gte' in operator) return compareForRange(value, operator.$gte) >= 0
    if ('$lt' in operator) return compareForRange(value, operator.$lt) < 0
    if ('$lte' in operator) return compareForRange(value, operator.$lte) <= 0
  }
  return valuesEqual(value, operator)
}

// Numbers and Dates compare by value; anything else never matches a range.
function compareForRange(value, bound) {
  if (typeof value === 'number' && typeof bound === 'number') return value - bound
  if (value instanceof Date && bound instanceof Date) return value.getTime() - bound.getTime()
  return NaN
}

function matches(doc, filter) {
  if (!filter || Object.keys(filter).length === 0) return true
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(expected)) {
      if (!expected.every((sub) => matches(doc, sub))) return false
      continue
    }
    if (key === '$or' && Array.isArray(expected)) {
      if (!expected.some((sub) => matches(doc, sub))) return false
      continue
    }
    const value = getPath(doc, key)
    if (!matchesOperator(value, expected)) return false
  }
  return true
}

function applyUpdate(doc, update) {
  if (!update) return
  if (update.$set) {
    for (const [key, value] of Object.entries(update.$set)) setPath(doc, key, value)
  }
  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) deletePath(doc, key)
  }
  if (update.$inc) {
    for (const [key, value] of Object.entries(update.$inc)) {
      setPath(doc, key, (getPath(doc, key) || 0) + value)
    }
  }
}

function compareValues(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

class FakeCursor {
  constructor(docs) {
    this.docs = docs
  }

  sort(spec) {
    const entries = Object.entries(spec)
    this.docs = [...this.docs].sort((a, b) => {
      for (const [key, direction] of entries) {
        const cmp = compareValues(getPath(a, key), getPath(b, key))
        if (cmp !== 0) return direction === -1 ? -cmp : cmp
      }
      return 0
    })
    return this
  }

  limit(n) {
    this.docs = this.docs.slice(0, n)
    return this
  }

  async toArray() {
    return [...this.docs]
  }
}

class FakeCollection {
  constructor(name) {
    this.name = name
    this.docs = []
  }

  find(filter = {}) {
    return new FakeCursor(this.docs.filter((doc) => matches(doc, filter)))
  }

  async findOne(filter = {}) {
    return this.docs.find((doc) => matches(doc, filter)) || null
  }

  async insertOne(doc) {
    const stored = { ...doc }
    if (stored._id === undefined) stored._id = new ObjectId()
    // Mongo rejects a second document with the same _id (duplicate-key
    // error 11000). The webhook and verify-session dedup paths depend on it.
    if (this.docs.some((d) => String(d._id) === String(stored._id))) {
      const err = new Error(
        `E11000 duplicate key error collection: ${this.name} index: _id_ dup key: { _id: ${stored._id} }`,
      )
      err.code = 11000
      throw err
    }
    this.docs.push(stored)
    return { insertedId: stored._id, acknowledged: true }
  }

  async updateOne(filter, update, options = {}) {
    const doc = this.docs.find((d) => matches(d, filter))
    if (!doc) {
      // Upsert: build the document from the plain-equality filter fields
      // plus the $set payload (what signup uses for the pending record).
      if (options.upsert) {
        const created = {}
        for (const [key, value] of Object.entries(filter || {})) {
          if (typeof value !== 'object' || value === null || isObjectId(value)) setPath(created, key, value)
        }
        applyUpdate(created, update)
        if (created._id === undefined) created._id = new ObjectId()
        this.docs.push(created)
        return { matchedCount: 0, modifiedCount: 0, upsertedId: created._id }
      }
      return { matchedCount: 0, modifiedCount: 0 }
    }
    applyUpdate(doc, update)
    return { matchedCount: 1, modifiedCount: 1 }
  }

  async findOneAndDelete(filter) {
    const index = this.docs.findIndex((d) => matches(d, filter))
    if (index === -1) return null
    const [doc] = this.docs.splice(index, 1)
    return doc
  }

  async deleteOne(filter) {
    const index = this.docs.findIndex((d) => matches(d, filter))
    if (index === -1) return { deletedCount: 0 }
    this.docs.splice(index, 1)
    return { deletedCount: 1 }
  }

  async deleteMany(filter) {
    const before = this.docs.length
    this.docs = this.docs.filter((d) => !matches(d, filter))
    return { deletedCount: before - this.docs.length }
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const doc = this.docs.find((d) => matches(d, filter))
    if (!doc) return null
    applyUpdate(doc, update)
    // The approval manager treats the return value as the updated document.
    return options.returnDocument === 'before' ? doc : doc
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((doc) => matches(doc, filter)).length
  }

  async createIndex() {
    return 'test-index'
  }

  async createSearchIndex() {
    throw new Error('createSearchIndex is not supported by the test fake')
  }

  listSearchIndexes() {
    // No Atlas index exists in the fake, so vectorStore uses exact cosine.
    return { toArray: async () => [] }
  }

  aggregate() {
    throw new Error('aggregate is not implemented in the test fake')
  }
}

class FakeDb {
  constructor() {
    this.collections = new Map()
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new FakeCollection(name))
    }
    return this.collections.get(name)
  }

  __reset() {
    this.collections.clear()
  }

  __dump(name) {
    const collection = this.collections.get(name)
    return collection ? [...collection.docs] : []
  }
}

const db = new FakeDb()

async function getDb() {
  return db
}

module.exports = { getDb, __db: db, __reset: () => db.__reset(), __dump: (name) => db.__dump(name) }
