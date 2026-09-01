import { useEffect, useState } from 'react';
import './CooldownPage.css';

interface CooldownInfo {
  seconds: number;
  streak: number;
  quote?: string;
}

/**
 * The full-screen pause. Deliberately not themed and deliberately offers
 * nothing to click: the whole point is that there is no way through it except
 * waiting. The countdown here is only what the reader sees — the authoritative
 * timer runs in the main process, so a hung renderer cannot extend the block.
 */
export function CooldownPage() {
  const [info, setInfo] = useState<CooldownInfo | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    const off = window.electronAPI.onCooldownInfo?.((next) => {
      setInfo(next);
      setRemaining(next.seconds);
    });
    return off;
  }, []);

  useEffect(() => {
    if (remaining === null) return;
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((r) => (r === null ? null : r - 1)), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  const shown = remaining ?? info?.seconds ?? 0;

  return (
    <div className="cooldown">
      <div className="cooldown-inner">
        <div className="cooldown-eyebrow">
          {info ? `${info.streak} записи подряд на повышенных` : 'Пауза'}
        </div>
        <h1 className="cooldown-title">Ты слишком нервничаешь.</h1>
        <p className="cooldown-subtitle">Остынь немного.</p>

        {info?.quote && <blockquote className="cooldown-quote">«{info.quote}»</blockquote>}

        <div className="cooldown-countdown" aria-live="off">
          {Math.max(0, shown)}
        </div>
        <div className="cooldown-unit">секунд</div>
      </div>
    </div>
  );
}
