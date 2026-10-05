'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icons';

/**
 * Floating back-to-top button that smoothly appears when scrolling down.
 */
export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frameId: number | null = null;

    const onScroll = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        setVisible(window.scrollY > 350);
        frameId = null;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="Scroll back to top"
      className={`fixed bottom-6 right-6 z-40 grid h-11 w-11 place-items-center rounded-full border border-slate-300 bg-white/95 text-slate-800 shadow-elevated backdrop-blur-md transition-all duration-300 hover:scale-110 hover:border-slate-900 hover:bg-slate-900 hover:text-white active:scale-95 ${
        visible
          ? 'translate-y-0 opacity-100 pointer-events-auto'
          : 'translate-y-6 opacity-0 pointer-events-none'
      }`}
    >
      <Icon name="arrow" className="h-4 w-4 -rotate-90 transition-transform duration-200 group-hover:-translate-y-0.5" />
    </button>
  );
}
