/**
 * Mailer stand-in used ONLY by the Phase 3 tests (tests/phase3).
 * Captures every sent mail so cases can read the token out of the message
 * the user would receive, without sending anything.
 */
'use strict'

let sent = []

async function sendEmail(mail) {
  sent.push(mail)
  return { messageId: 'test-message-id' }
}

function __sent() {
  return sent
}

function __lastTo(email) {
  const matches = sent.filter((mail) => mail.to === email)
  return matches[matches.length - 1] || null
}

function __reset() {
  sent = []
}

module.exports = { sendEmail, __sent, __lastTo, __reset }
