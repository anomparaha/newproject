'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '@/components/Icons';

interface Props {
  label: string;
  value: string;
  hint?: string;
  icon?: IconName;
  delay?: number;
}

/**
 * Metric card with entrance animation and smooth number rolling when visible.
 */
export function AnimatedMetric({ label, value, hint, icon, delay = 0 }: Props) {
  const [displayValue, setDisplayValue] = useState<string>(value);
  const [revealed, setRevealed] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = cardRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setRevealed(true);
          observer.unobserve(node);

          // Check if value is numeric or has percentage/hours
          const match = value.match(/^([\d.]+)(.*)$/);
          if (match && match[1]) {
            const targetNum = parseFloat(match[1]);
            const suffix = match[2] || '';
            const isFloat = match[1].includes('.');
            const decimals = isFloat ? (match[1].split('.')[1]?.length ?? 1) : 0;

            const duration = 900;
            const startTime = performance.now();

            const animate = (currentTime: number) => {
              const elapsed = currentTime - startTime;
              const progress = Math.min(1, elapsed / duration);
              // Ease out cubic
              const easeOut = 1 - Math.pow(1 - progress, 3);
              const currentNum = targetNum * easeOut;

              setDisplayValue(`${currentNum.toFixed(decimals)}${suffix}`);

              if (progress < 1) {
                requestAnimationFrame(animate);
              } else {
                setDisplayValue(value);
              }
            };

            setTimeout(() => {
              requestAnimationFrame(animate);
            }, delay + 100);
          }
        }
      },
      { threshold: 0.15 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [value, delay]);

  return (
    <div
      ref={cardRef}
      style={{
        opacity: revealed ? 1 : 0,
        transform: revealed ? 'translate3d(0, 0, 0)' : 'translate3d(0, 20px, 0)',
        transition: 'opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1), transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
        transitionDelay: `${delay}ms`,
      }}
      className="card group relative overflow-hidden p-5 transition-all duration-300 hover:-translate-y-1 hover:shadow-elevated hover:border-slate-400 bg-white"
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-muted">{label}</div>
        {icon ? (
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-800 border border-slate-200 transition-colors group-hover:bg-slate-900 group-hover:text-white group-hover:border-slate-900 shadow-2xs">
            <Icon name={icon} className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <div className="mt-3 text-3xl font-extrabold tabular-nums tracking-tight text-ink">
        {displayValue}
      </div>
      {hint ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
          <span>{hint}</span>
        </div>
      ) : null}
    </div>
  );
}
