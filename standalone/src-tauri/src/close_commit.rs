//! Cancellation owns only preparation. Once a worker crosses the mutation
//! boundary, its caller must await the result rather than release save refusal
//! while a late unlink still owns the window's files.
use std::sync::atomic::{AtomicU8, Ordering};

const PREPARING: u8 = 0;
const COMMITTING: u8 = 1;
const DONE: u8 = 2;
const CANCELLED: u8 = 3;

#[derive(Debug, Default)]
pub struct CloseCommit(AtomicU8);

impl CloseCommit {
    /// Called under the journal lock, immediately before the first mutation.
    pub fn begin(&self) -> Result<(), String> {
        self.0.compare_exchange(PREPARING, COMMITTING, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ()).map_err(|_| "close preparation was cancelled".to_string())
    }

    pub fn cancel(&self) -> bool {
        self.0.compare_exchange(PREPARING, CANCELLED, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }

    pub fn finish(&self) { self.0.store(DONE, Ordering::Release); }
    pub fn done(&self) -> bool { self.0.load(Ordering::Acquire) == DONE }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn cancellation_while_waiting_for_journal_fences_the_late_worker() {
        let disk = Arc::new(Mutex::new(()));
        let blocked = disk.lock().unwrap();
        let token = Arc::new(CloseCommit::default());
        let worker_token = token.clone();
        let worker_disk = disk.clone();
        let worker = std::thread::spawn(move || {
            let _disk = worker_disk.lock().unwrap();
            worker_token.begin()
        });
        assert!(token.cancel());
        drop(blocked);
        assert!(worker.join().unwrap().is_err());
        assert!(!token.done());
        // A retry owns a distinct generation; cancelling the old token cannot
        // cancel or authorize the new worker.
        let retry = CloseCommit::default();
        retry.begin().unwrap();
        assert!(!token.cancel());
        retry.finish();
        assert!(retry.done());
    }

    #[test]
    fn entered_commit_cannot_be_cancelled_or_reentered() {
        let token = CloseCommit::default();
        token.begin().unwrap();
        assert!(!token.cancel());
        assert!(!token.done());
        assert!(token.begin().is_err());
        token.finish();
        assert!(token.done());
        assert!(!token.cancel());
    }
}
