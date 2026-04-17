# ERRORS.md - Automatic Error Tracking & Learning

## [2026-04-17 21:10] - Audit Fix: Firestore Transaction Hardening

- **Type**: Logic/Runtime
- **Severity**: High
- **File**: `src/App.jsx`
- **Agent**: Antigravity
- **Root Cause**: `transaction.update` was used on potentially non-existent stats documents, causing `NOT_FOUND` errors during session save and breakthrough.
- **Fix Applied**: Replaced `transaction.update` with `transaction.set(..., { merge: true })`.
- **Prevention**: Always use `set` with `merge` when updating documents that might not yet exist in an atomic block.
- **Status**: Fixed

---

## [2026-04-17 21:10] - Audit Fix: Async Side-effect in Snapshot Listener

- **Type**: Logic/Async
- **Severity**: Medium
- **File**: `src/App.jsx`
- **Agent**: Antigravity
- **Root Cause**: Streak updates were performed directly inside the `onSnapshot` listener, causing potential re-entrant loops and race conditions.
- **Fix Applied**: Moved streak logic to a dedicated `useEffect` using a transaction that runs once per session.
- **Prevention**: Avoid writing back to the same document directly from a real-time listener callback.
- **Status**: Fixed

---

## [2026-04-17 21:10] - Audit Fix: Unsafe AI Response Parsing

- **Type**: Runtime/Null Access
- **Severity**: High
- **File**: `src/App.jsx`
- **Agent**: Antigravity
- **Root Cause**: AI responses were accessed without optional chaining, leading to crashes if the response structure was unexpected.
- **Fix Applied**: Added optional chaining and explicit structure validation in `generateText`.
- **Prevention**: Always treat external API responses as untrusted and use optional chaining/validation.
- **Status**: Fixed

---

## [2026-04-17 21:10] - Audit Fix: Analytics Initialization Failure

- **Type**: Environment
- **Severity**: Medium
- **File**: `src/firebase.js`
- **Agent**: Antigravity
- **Root Cause**: `getAnalytics` was called without checking if the environment supports it (e.g. ad blockers, private mode).
- **Fix Applied**: Wrapped initialization with `isSupported().then(...)`.
- **Prevention**: Use standard Firebase support checks for environment-dependent features.
- **Status**: Fixed
