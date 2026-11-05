import { useState } from 'react';

interface Props {
  src: string;
  alt: string;
  className?: string;
}

/** 封面图：加载失败时给一块渐变占位，不显示浏览器的破图标。 */
export default function Cover({ src, alt, className = '' }: Props) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`cover-fallback ${className}`} title={alt}>
        <span>{alt.slice(0, 1)}</span>
      </div>
    );
  }
  return (
    <img
      className={`cover ${className}`}
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
