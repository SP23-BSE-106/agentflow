/**
 * next/server stand-in used ONLY by the Phase 3 tests (tests/phase3).
 * NextResponse extends the platform Response so `instanceof NextResponse`
 * checks in product code keep working, and .json() reads back as usual.
 */
'use strict'

class NextResponse extends Response {
  static json(data, init = {}) {
    return new NextResponse(JSON.stringify(data), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  static redirect(url, init = {}) {
    return new NextResponse(null, {
      status: init.status ?? 307,
      headers: { Location: String(url) },
    })
  }
}

class NextRequest extends Request {}

module.exports = { NextResponse, NextRequest }
