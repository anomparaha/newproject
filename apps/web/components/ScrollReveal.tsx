'use client';

import {
  type ElementType,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

type Direction = 'up' | 'down' | 'left' | 'right' | 'fade' | 'zoom';

interface ScrollRevealProps {
  children: ReactNode;
  direction?: Direction;
  delay?: number; // in milliseconds
  duration?: number; // in milliseconds
  distance?: number; // in pixels
  className?: string;
  as?: ElementType;
  threshold?: number;
  once?: boolean;
}

const StaggerContext = createContext<number | null>(null);

/**
 * High-performance, hardware-accelerated Scroll Reveal wrapper.
 * Utilizes IntersectionObserver and CSS transitions for silky smooth 60fps animations.
 * Automatically respects user's prefers-reduced-motion setting.
 */
export function ScrollReveal({
  children,
  direction = 'up',
  delay = 0,
  duration = 650,
  distance = 24,
  className = '',
  as: Component = 'div',
  threshold = 0.12,
  once = true,
}: ScrollRevealProps) {
  const [revealed, setRevealed] = useState(false);
  const elementRef = useRef<HTMLElement | null>(null);
  const staggerIndex = useContext(StaggerContext);

  const effectiveDelay = staggerIndex !== null ? delay + staggerIndex * 90 : delay;

  useEffect(() => {
    // Immediate reveal if user prefers reduced motion
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRevealed(true);
      return;
    }

    const node = elementRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setRevealed(true);
          if (once) observer.unobserve(node);
        } else if (!once) {
          setRevealed(false);
        }
      },
      {
        threshold,
        rootMargin: '0px 0px -40px 0px',
      }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [once, threshold]);

  // Compute transform offset based on direction
  const getInitialTransform = () => {
    switch (direction) {
      case 'up':
        return `translate3d(0, ${distance}px, 0)`;
      case 'down':
        return `translate3d(0, -${distance}px, 0)`;
      case 'left':
        return `translate3d(${distance}px, 0, 0)`;
      case 'right':
        return `translate3d(-${distance}px, 0, 0)`;
      case 'zoom':
        return `scale(0.96) translate3d(0, ${distance / 2}px, 0)`;
      case 'fade':
      default:
        return 'translate3d(0, 0, 0)';
    }
  };

  const style = {
    opacity: revealed ? 1 : 0,
    transform: revealed ? 'translate3d(0, 0, 0) scale(1)' : getInitialTransform(),
    transitionProperty: 'opacity, transform',
    transitionDuration: `${duration}ms`,
    transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    transitionDelay: `${effectiveDelay}ms`,
    willChange: revealed ? 'auto' : 'opacity, transform',
  };

  return (
    <Component
      ref={elementRef}
      style={style}
      className={`reveal-element ${revealed ? 'is-revealed' : ''} ${className}`}
    >
      {children}
    </Component>
  );
}

/**
 * Container that automatically sequences stagger delays for each direct child.
 */
export function ScrollStagger({
  children,
  className = '',
  as: Component = 'div',
}: {
  children: ReactNode[];
  className?: string;
  as?: ElementType;
}) {
  return (
    <Component className={className}>
      {children.map((child, index) => (
        <StaggerContext.Provider key={index} value={index}>
          {child}
        </StaggerContext.Provider>
      ))}
    </Component>
  );
}
