import { useId } from 'react';

type LunchLineupMarkProps = {
  size?: number;
  title?: string;
};

export function LunchLineupMark({ size = 34, title }: LunchLineupMarkProps) {
  const gradientId = useId();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f79ff" />
          <stop offset="100%" stopColor="#22b8cf" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${gradientId})`} />
      <path d="M18 22h28a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V26a4 4 0 0 1 4-4Z" fill="#fff" opacity=".95" />
      <path d="M24 18a2 2 0 1 1 4 0v6h-4v-6Zm12 0a2 2 0 1 1 4 0v6h-4v-6Z" fill="#fff" />
      <rect x="20" y="32" width="24" height="4" rx="2" fill="#4f79ff" />
    </svg>
  );
}
