import { interrupted } from './errors.js';

// Cooperative interruption token for long operations (Ctrl+C).
// Long loops check `isInterrupted()` between units of work and abort
// safely instead of leaving partial state behind.
export function createInterrupt() {
  let flag = false;
  return {
    get interrupted() {
      return flag;
    },
    interrupt() {
      flag = true;
    },
    reset() {
      flag = false;
    },
    throwIfInterrupted(op = 'operation') {
      if (flag) throw interrupted(op);
    },
  };
}

export function isInterruptError(err) {
  return !!err && (err.code === 'INTERRUPTED' || err.exitCode === 130);
}
