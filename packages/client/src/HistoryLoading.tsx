import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './history-loading.css';

export function HistoryLoading({ progress, cancel }: { progress: number; cancel: () => void }) {
  const button = useRef<HTMLButtonElement>(null), cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root'), wasInert = root?.inert;
    if (root) root.inert = true;
    button.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRef.current(); }
      if (event.key === 'Tab') { event.preventDefault(); button.current?.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      if (root) root.inert = wasInert ?? false;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div className="history-loading-backdrop">
      <section className="history-loading-dialog" role="dialog" aria-modal="true" aria-labelledby="history-loading-title" aria-describedby="history-loading-description">
        <div className="history-loading-orbit" aria-hidden="true"><span /></div>
        <h2 id="history-loading-title">正在加载历史</h2>
        <p id="history-loading-description">首次准备约15秒，完成后即可回看。</p>
        <div className="history-loading-progress">
          <progress aria-label="历史加载进度" max={100} value={Math.min(99, Math.round(progress * 100))} />
          <span>{Math.min(99, Math.round(progress * 100))}%</span>
        </div>
        <button ref={button} onClick={cancel}>取消加载</button>
      </section>
    </div>, document.body,
  );
}
