import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { resolveResponsiveImage } from '../utils/responsiveImage';

export interface OptimizedImageProps {
  src: string;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
  width?: number;
  height?: number;
  version?: string | number;
  fallbackLabel?: string;
  onClick?: React.MouseEventHandler<HTMLElement>;
}

export const OptimizedImage: React.FC<OptimizedImageProps> = ({
  src,
  alt,
  className = '',
  sizes = '(max-width: 767px) 50vw, (max-width: 1023px) 33vw, 25vw',
  priority = false,
  width,
  height,
  version,
  fallbackLabel,
  onClick,
}) => {
  const resolved = resolveResponsiveImage(src, version);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [resolved.fallbackSrc]);

  if (!resolved.fallbackSrc || hasError) {
    return (
      <div
        role="img"
        aria-label={alt}
        onClick={onClick}
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-[#14141A] via-[#0E0E13] to-[#08080A] text-[#D4AF37]/70 select-none ${className}`}
      >
        <Sparkles className="w-5 h-5 mb-1 shrink-0" />
        <span className="text-[10px] uppercase tracking-widest text-neutral-400 px-2 text-center line-clamp-1">
          {fallbackLabel || alt || 'RGD LUXE'}
        </span>
      </div>
    );
  }

  const resolvedWidth = width ?? resolved.width;
  const resolvedHeight = height ?? resolved.height;

  const imgProps = {
    src: resolved.fallbackSrc,
    alt,
    width: resolvedWidth,
    height: resolvedHeight,
    loading: (priority ? 'eager' : 'lazy') as 'eager' | 'lazy',
    decoding: (priority ? 'sync' : 'async') as 'sync' | 'async',
    fetchPriority: (priority ? 'high' : 'auto') as 'high' | 'auto',
    referrerPolicy: 'no-referrer' as const,
    className,
    onError: () => setHasError(true),
  };

  if (resolved.webpSrcSet) {
    return (
      <picture className="contents" onClick={onClick}>
        <source type="image/webp" srcSet={resolved.webpSrcSet} sizes={sizes} />
        <img {...imgProps} />
      </picture>
    );
  }

  return <img {...imgProps} onClick={onClick} />;
};
