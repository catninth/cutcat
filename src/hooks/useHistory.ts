import { useCallback, useRef, useState } from "react";

interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

export function useHistory<T>(initialValue: T) {
  const [history, setHistory] = useState<HistoryState<T>>({
    past: [],
    present: initialValue,
    future: [],
  });
  const historyRef = useRef(history);
  historyRef.current = history;

  const commit = useCallback((nextValue: T) => {
    setHistory((current) => {
      if (Object.is(current.present, nextValue)) return current;
      return {
        past: [...current.past.slice(-99), current.present],
        present: nextValue,
        future: [],
      };
    });
  }, []);

  const reset = useCallback((nextValue: T) => {
    setHistory({ past: [], present: nextValue, future: [] });
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (previous === undefined) return current;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      const next = current.future[0];
      if (next === undefined) return current;
      return {
        past: [...current.past, current.present],
        present: next,
        future: current.future.slice(1),
      };
    });
  }, []);

  const getValue = useCallback(() => historyRef.current.present, []);

  return {
    value: history.present,
    commit,
    reset,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    getValue,
  };
}
